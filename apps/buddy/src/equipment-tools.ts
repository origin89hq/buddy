import { type Installation, kinds } from "@origin89/buddy";
import { tool } from "ai";
import { z } from "zod";
import {
  identityKey,
  type KnowledgeContext,
  type KnowledgeDatabase,
  parseKnowledgeRecord,
  retrieveKnowledgeKeys,
} from "./knowledge.ts";
import { solarChecks } from "./solar-checks.ts";

export const equipmentToolLimits = {
  calls: 6,
  candidates: 5,
  searchRows: 64,
  resultCharacters: 8000,
  totalCharacters: 16000,
  modelSteps: 3,
} as const;

const identitySchema = z
  .object({
    brand: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("Manufacturer from the user, saved equipment or a search candidate."),
    model: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("Complete model including electrical-variant suffixes. Never guess a suffix."),
  })
  .strict();
const searchSchema = z
  .object({
    brand: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("Known manufacturer. Ask for the brand if it is unknown."),
    modelPrefix: z
      .string()
      .trim()
      .max(80)
      .describe("Readable beginning of the model; empty to browse this brand. No wildcards."),
    kind: z.enum(kinds).nullable().describe("Equipment category when known; otherwise null."),
  })
  .strict();

// The existing alias primary key supports a bounded range scan. No catalogue-wide
// JSON scan, fuzzy electrical-variant match, new index or duplicate catalogue.
export const equipmentSearchQuery = `SELECT a.lookup_key, a.record_id, r.record_json
  FROM knowledge_aliases a
  JOIN knowledge_records r ON r.id = a.record_id
  LEFT JOIN knowledge_catalogues c ON c.id = r.catalogue_id
  WHERE a.lookup_key >= ? AND a.lookup_key < ? AND r.status = 'verified'
    AND (r.catalogue_id IS NULL OR c.active_revision = r.catalogue_revision)
  ORDER BY a.lookup_key, a.record_id LIMIT ${equipmentToolLimits.searchRows + 1}`;

export async function searchEquipment(
  db: KnowledgeDatabase | undefined,
  input: z.infer<typeof searchSchema>,
) {
  const { brand, modelPrefix, kind } = searchSchema.parse(input);
  const prefix = identityKey(brand, modelPrefix);
  if (!prefix || identityKey(brand, "").length < 2)
    return { status: "needs-brand" as const, candidates: [], truncated: false };
  if (!db) return { status: "unavailable" as const, candidates: [], truncated: false };
  try {
    const rows = (
      await db.prepare(equipmentSearchQuery).bind(prefix, `${prefix}\u{10ffff}`).all<{
        lookup_key: string;
        record_id: string;
        record_json: string;
      }>()
    ).results;
    const candidates: {
      id: string;
      brand: string;
      model: string;
      kind: string;
      revision: string;
    }[] = [];
    const seen = new Set<string>();
    let truncated = rows.length > equipmentToolLimits.searchRows;
    for (const row of rows.slice(0, equipmentToolLimits.searchRows)) {
      const record = parseKnowledgeRecord(row.record_json);
      const catalogueKind =
        kind === "panel" ? "solar-panel" : kind === "monitor" ? "battery-monitor" : kind;
      if (
        !record ||
        record.id !== row.record_id ||
        seen.has(record.id) ||
        (kind && record.kind !== kind && record.kind !== catalogueKind)
      )
        continue;
      // A range can include a longer manufacturer name. Verify the brand and
      // actual alias in the payload before presenting the candidate.
      const match = [record, ...record.aliases].some(
        (alias) =>
          identityKey(alias.brand, "") === identityKey(brand, "") &&
          identityKey("", alias.model).startsWith(identityKey("", modelPrefix)) &&
          identityKey(alias.brand, alias.model) === row.lookup_key,
      );
      if (!match) continue;
      seen.add(record.id);
      if (candidates.length >= equipmentToolLimits.candidates) {
        truncated = true;
        break;
      }
      candidates.push({
        id: record.id,
        brand: record.brand,
        model: record.model,
        kind: record.kind,
        revision: record.source.revision,
      });
    }
    return {
      status: candidates.length ? ("candidates" as const) : ("no-match" as const),
      candidates,
      truncated,
      note: truncated
        ? "Only a bounded part of this prefix was searched. Ask for more of the model label; this is not an exhaustive list."
        : "Candidates are not confirmed installed equipment. Retrieve the complete brand/model before citing any ratings.",
    };
  } catch {
    return { status: "unavailable" as const, candidates: [], truncated: false };
  }
}

export interface EquipmentToolTrace {
  name: string;
  status: string;
  elapsedMs: number;
  cached: boolean;
}

/** Read-only tools, caches and source allowlist belong to one conversation turn. */
export function createEquipmentTools(
  db: KnowledgeDatabase | undefined,
  installation: Installation,
  prefetched: KnowledgeContext,
  signal: AbortSignal,
) {
  const records = new Map(prefetched.records.map((record) => [record.id, record]));
  const exactCache = new Map<string, Promise<KnowledgeContext>>();
  const resultCache = new Map<string, Promise<object>>();
  const traces: EquipmentToolTrace[] = [];
  const snapshot = structuredClone(installation);
  let calls = 0,
    characters = 0;

  async function exact(input: z.infer<typeof identitySchema>) {
    const key = identityKey(input.brand, input.model);
    let cached = exactCache.get(key);
    if (!cached) {
      // The prefetch already resolved active-revision ambiguity for these keys.
      const matches = prefetched.records.filter(
        (record) => identityKey(record.brand, record.model) === key,
      );
      cached =
        matches.length === 1
          ? Promise.resolve({ status: "available" as const, records: matches, truncated: false })
          : retrieveKnowledgeKeys(db, [key]);
      exactCache.set(key, cached);
    }
    return cached;
  }
  function knowledge(): KnowledgeContext {
    return {
      status: records.size ? "available" : prefetched.status,
      records: [...records.values()],
      truncated: prefetched.truncated,
    };
  }
  function remember(context: KnowledgeContext) {
    for (const record of context.records) records.set(record.id, record);
  }
  async function bounded(
    name: string,
    input: object,
    run: () => Promise<object>,
    rememberResult?: (result: object) => void,
  ) {
    signal.throwIfAborted();
    const started = performance.now();
    let status = "error",
      cached = false;
    try {
      if (++calls > equipmentToolLimits.calls) {
        status = "budget-exhausted";
        return { status };
      }
      const key = `${name}:${JSON.stringify(input)}`;
      let pending = resultCache.get(key);
      cached = !!pending;
      if (!pending) {
        pending = run();
        resultCache.set(key, pending);
      }
      const result = await pending;
      signal.throwIfAborted();
      const size = JSON.stringify(result).length;
      if (
        size > equipmentToolLimits.resultCharacters ||
        characters + size > equipmentToolLimits.totalCharacters
      ) {
        status = "budget-exhausted";
        return {
          status,
          note: "The lookup result limit was reached. Answer from information already returned; leave missing details unknown.",
        };
      }
      characters += size;
      rememberResult?.(result);
      status =
        "status" in result && typeof result.status === "string" ? result.status : "available";
      return result;
    } catch {
      signal.throwIfAborted();
      status = "unavailable";
      return { status, note: "Lookup failed; specifications remain unknown." };
    } finally {
      traces.push({
        name,
        status,
        cached,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      });
    }
  }

  const tools = {
    search_equipment: tool({
      description:
        "Find candidate models for a known brand and partial model label. Indexed prefix search; narrow a truncated result with more label text. A candidate is not an identification and never updates the installation.",
      inputSchema: searchSchema,
      execute: (input) => bounded("search_equipment", input, () => searchEquipment(db, input)),
    }),
    get_equipment: tool({
      description:
        "Retrieve sourced specifications for an EXACT complete brand/model. Use when these specs are missing from retrievedKnowledge. Preserves suffixes, test conditions and source IDs. No match also covers ambiguous revisions; do not substitute another variant.",
      inputSchema: identitySchema,
      execute: (input) =>
        bounded(
          "get_equipment",
          input,
          () => exact(input),
          (result) => remember(result as KnowledgeContext),
        ),
    }),
    get_monitoring_options: tool({
      description:
        "Retrieve exact-model Origin89 integration status, ports, available versus implemented readings, and external monitoring suggestions. Missing integration means unknown support. Suggested devices are not owned or installed, and prices are unavailable.",
      inputSchema: identitySchema,
      execute: (input) => {
        let found: KnowledgeContext | undefined;
        return bounded(
          "get_monitoring_options",
          input,
          async () => {
            found = await exact(input);
            return {
              status: found.status,
              truncated: found.truncated,
              records: found.records.map(
                ({ id, brand, model, integration, source, limitations }) => ({
                  id,
                  brand,
                  model,
                  source,
                  limitations,
                  integration: integration ?? null,
                  supportKnown: !!integration,
                }),
              ),
            };
          },
          () => {
            // A cached result still needs only sources from this turn's exact lookup.
            if (found) remember(found);
          },
        );
      },
    }),
    check_setup: tool({
      description:
        "Run deterministic solar-array checks on the SAVED installation using exact specs retrieved so far. Returns missing inputs and conditional warnings, never safety approval. It cannot see unsaved details in this message or change the installation. Use existing solarChecks if already sufficient.",
      inputSchema: z.object({}).strict(),
      execute: () =>
        bounded("check_setup", { recordIds: [...records.keys()].sort() }, async () => ({
          status: "available",
          basis: "saved-installation",
          revision: snapshot.revision,
          checks: solarChecks(snapshot, knowledge()),
          note: "Only saved arrays and explicitly associated controllers are assessed. No live measurements or wiring verification. Newly supplied details are checked after they are saved.",
        })),
    }),
  };
  return { tools, knowledge, traces, exhausted: () => calls >= equipmentToolLimits.calls };
}
