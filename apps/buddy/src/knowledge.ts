import {
  type Installation,
  type KnowledgePreview,
  type KnowledgeSource,
  newInstallation,
} from "@origin89/buddy";
import { z } from "zod";

export const integrationSchema = z
  .object({
    status: z.enum(["passive", "documented", "decoder-implemented", "hardware-verified"]),
    driver: z.string().max(100).nullable(),
    ports: z
      .array(
        z
          .object({
            name: z.string().max(80),
            protocol: z.string().max(80),
            settings: z.string().max(150),
            adapter: z.string().max(200),
          })
          .strict(),
      )
      .max(4),
    availableMetrics: z
      .array(
        z
          .object({
            name: z.string().max(80),
            unit: z.string().max(30).nullable(),
            nature: z.enum(["measured", "estimated", "status"]),
            conditions: z.string().max(200),
          })
          .strict(),
      )
      .max(16),
    implementedMetrics: z.array(z.string().max(80)).max(16),
    monitoringOptions: z
      .array(
        z
          .object({
            brand: z.string().max(80),
            model: z.string().max(80),
            purpose: z.string().max(200),
            limitations: z.string().max(240),
          })
          .strict(),
      )
      .max(3),
    limitations: z.array(z.string().max(240)).max(8),
    // `external` marks a document this repository cites but does not carry: a
    // vendor manual that is not ours to redistribute, or research kept private.
    // Its digest still records which revision was read. There is nothing here to
    // compare it against, so it is provenance and never a check.
    evidence: z
      .array(
        z
          .object({
            path: z.string().max(150),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            note: z.string().max(200),
            external: z.literal(true).optional(),
            url: z
              .url()
              .refine((url) => new URL(url).protocol === "https:")
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict()
  .superRefine((integration, ctx) => {
    if (
      ["passive", "documented"].includes(integration.status) &&
      (integration.driver || integration.implementedMetrics.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unimplemented or passive profiles cannot claim a driver or implemented metrics",
      });
    if (
      integration.status === "passive" &&
      (integration.ports.length || integration.availableMetrics.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Passive equipment does not expose ports or telemetry",
      });
    if (
      integration.implementedMetrics.some(
        (name) => !integration.availableMetrics.some((metric) => metric.name === name),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Implemented metrics must be a subset of available metrics",
      });
  });

// Bounded records, independent of catalogue size. Raw manuals belong in object storage.
export const knowledgeRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,100}$/),
    brand: z.string().min(1).max(80),
    model: z.string().min(1).max(80),
    kind: z.string().min(1).max(40),
    aliases: z
      .array(z.object({ brand: z.string().min(1).max(80), model: z.string().min(1).max(80) }))
      .max(12),
    review: z.object({
      status: z.literal("verified"),
      checkedAt: z.iso.date(),
      reviewedBy: z.string().min(1).max(100),
    }),
    source: z
      .object({
        type: z
          .enum(["manufacturer-document", "component-catalogue"])
          .default("manufacturer-document"),
        title: z.string().min(1).max(150),
        url: z
          .url()
          .max(1000)
          .refine((url) => new URL(url).protocol === "https:"),
        page: z.number().int().positive().optional(),
        row: z.number().int().positive().optional(),
        section: z.string().min(1).max(120).optional(),
        revision: z.string().min(1).max(80),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .refine(
        (source) => [source.page, source.row, source.section].filter(Boolean).length === 1,
        "Provide one PDF page, CSV row or HTML section",
      ),
    specifications: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          value: z.union([z.number().finite(), z.string().min(1).max(100)]),
          unit: z.string().max(30).nullable(),
          conditions: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(24),
    limitations: z.array(z.string().min(1).max(200)).max(6),
    integration: integrationSchema.optional(),
    certifications: z
      .array(
        z
          .object({
            standard: z.string().min(1).max(80),
            edition: z.string().min(1).max(80),
            certifyingBody: z.string().min(1).max(100),
            certificateDate: z.iso.date(),
            evidence: z.literal("catalogue-reported"),
          })
          .strict(),
      )
      .max(6)
      .optional(),
  })
  .strict()
  .refine((record) => JSON.stringify(record).length <= 12000, "Record exceeds 12,000 characters");
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

export const knowledgeLimits = { keys: 80, records: 6, contextCharacters: 8000 } as const;

// Keep suffixes and punctuation such as '/' that can distinguish electrical variants.
export const identityKey = (brand: string, model: string) =>
  `${brand} ${model}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-‐‑–—]/g, "");

export function lookupKeys(installation: Installation, text: string): string[] {
  const keys = new Set<string>();
  // Exact brand + model mentions can be resolved on the first turn without another LLM call.
  // No bare model aliases: the same model string can exist under several manufacturers.
  const words = (text.slice(0, 3000).match(/[\p{L}\p{N}/._{}()‐‑–—-]+/gu) ?? []).map((word) =>
    word.replace(/\.+$/, ""),
  );
  for (let width = 2; width <= 5; width++) {
    for (let i = 0; i + width <= words.length && keys.size < 40; i++) {
      const phrase = words.slice(i, i + width).join(" ");
      if (/\d/.test(phrase)) keys.add(identityKey("", phrase));
    }
  }
  for (const item of installation.equipment) {
    if (item.brand && item.model) keys.add(identityKey(item.brand, item.model));
    if (keys.size >= knowledgeLimits.keys) break;
  }
  return [...keys].slice(0, knowledgeLimits.keys);
}

export function knowledgeQuery(count: number): string {
  if (!Number.isInteger(count) || count < 1 || count > knowledgeLimits.keys)
    throw new Error("Invalid lookup size");
  // An alias matching multiple revisions is ambiguous, even if one is not published yet.
  // Probe the composite PK, then the record PK. Never scan all specs or use LIKE '%...%'.
  return `WITH matches AS (
    SELECT a.lookup_key, MIN(a.record_id) AS record_id
    FROM knowledge_aliases a
    JOIN knowledge_records candidate ON candidate.id = a.record_id
    LEFT JOIN knowledge_catalogues c ON c.id = candidate.catalogue_id
    WHERE a.lookup_key IN (${Array.from({ length: count }, () => "?").join(",")})
      AND (candidate.catalogue_id IS NULL OR c.active_revision = candidate.catalogue_revision)
    GROUP BY a.lookup_key HAVING COUNT(*) = 1
  ) SELECT matches.lookup_key, r.record_json FROM matches
    JOIN knowledge_records r ON r.id = matches.record_id
    WHERE r.status = 'verified' LIMIT 80`;
}

export interface KnowledgeContext {
  status: "available" | "no-match" | "unavailable";
  records: (Omit<KnowledgeRecord, "aliases" | "review" | "integration"> & {
    integration?: Omit<z.infer<typeof integrationSchema>, "evidence">;
  })[];
  truncated: boolean;
}

// The narrow read interface also lets catalogue/tool tests use real SQLite.
export interface KnowledgeDatabase {
  prepare(query: string): {
    bind(...values: string[]): { all<T>(): Promise<{ results: T[] }> };
  };
}

export function parseKnowledgeRecord(json: string): KnowledgeRecord | null {
  if (json.length > 12000) return null;
  try {
    const parsed = knowledgeRecordSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function selectKnowledge(
  rows: { lookup_key: string; record_json: string }[],
  keys: string[],
): KnowledgeContext {
  const context: KnowledgeContext = { status: "no-match", records: [], truncated: false };
  const seen = new Set<string>();
  for (const key of keys) {
    for (const row of rows.filter((row) => row.lookup_key === key)) {
      const parsed = parseKnowledgeRecord(row.record_json);
      if (!parsed || seen.has(parsed.id)) continue;
      const { aliases, review, integration, ...base } = parsed;
      // Provenance hashes stay in the database/build report. The conversational
      // model needs capabilities and limitations, not repeated repository paths.
      const capabilities = integration
        ? (({ evidence, ...fields }) => fields)(integration)
        : undefined;
      const record = { ...base, ...(capabilities ? { integration: capabilities } : {}) };
      // Fail closed if the stored alias was attached to the wrong payload.
      if (![record, ...aliases].some((alias) => identityKey(alias.brand, alias.model) === key))
        continue;
      seen.add(record.id);
      const next = { ...context, status: "available", records: [...context.records, record] };
      if (
        context.records.length >= knowledgeLimits.records ||
        JSON.stringify(next).length > knowledgeLimits.contextCharacters
      ) {
        context.truncated = true;
        continue;
      }
      context.status = "available";
      context.records.push(record);
    }
  }
  return context;
}

export async function retrieveKnowledgeKeys(
  db: KnowledgeDatabase | undefined,
  keys: string[],
): Promise<KnowledgeContext> {
  if (!db) return { status: "unavailable", records: [], truncated: false };
  if (!keys.length) return { status: "no-match", records: [], truncated: false };
  try {
    const result = await db
      .prepare(knowledgeQuery(keys.length))
      .bind(...keys)
      .all<{ lookup_key: string; record_json: string }>();
    return selectKnowledge(result.results, keys);
  } catch {
    // Do not silently replace a failed lookup with model-memory specifications.
    console.warn(JSON.stringify({ event: "buddy_knowledge_unavailable" }));
    return { status: "unavailable", records: [], truncated: false };
  }
}

export async function retrieveKnowledge(
  db: KnowledgeDatabase | undefined,
  installation: Installation,
  text: string,
): Promise<KnowledgeContext> {
  return retrieveKnowledgeKeys(db, lookupKeys(installation, text));
}

export async function previewKnowledge(
  db: D1Database | undefined,
  text: string,
): Promise<KnowledgePreview> {
  const started = performance.now();
  // Show exact mentions in this message only. Saved equipment is context for the
  // answer, but an unrelated message must not flash old specs as a new discovery.
  const knowledge = await retrieveKnowledge(db, newInstallation(), text);
  return {
    lookupMs: Math.round((performance.now() - started) * 10) / 10,
    records: knowledge.records.slice(0, 2).map((record) => ({
      id: record.id,
      name: `${record.brand} ${record.model}`,
      specifications: record.specifications.slice(0, 3),
      source: citedSources(knowledge, [record.id])[0],
      ...(record.integration ? { integrationStatus: record.integration.status } : {}),
    })),
  };
}

export function citedSources(context: KnowledgeContext, ids: string[]): KnowledgeSource[] {
  return context.records
    .filter((record) => ids.includes(record.id))
    .map((record) => ({
      id: record.id,
      title: `${record.brand} ${record.model} · ${record.source.title}`,
      url: record.source.page
        ? `${record.source.url.split("#")[0]}#page=${record.source.page}`
        : record.source.url,
      ...(record.source.page
        ? { page: record.source.page }
        : record.source.row
          ? { row: record.source.row }
          : { section: record.source.section }),
      revision: record.source.revision,
    }));
}
