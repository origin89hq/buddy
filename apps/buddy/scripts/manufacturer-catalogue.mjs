import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { knowledgeRecordSchema } from "../src/knowledge.ts";
import { adapterFiles, adapters } from "./adapters/index.mjs";
import { activateCatalogueSql, recordSql } from "./import-knowledge.mjs";
import { integrationFor, loadIntegrationProfiles } from "./integration-profiles.mjs";
import { sha } from "./manufacturer-adapters.mjs";
import { resolveDuplicates } from "./sam-catalogue.mjs";

const run = promisify(execFile),
  appRoot = fileURLToPath(new URL("../", import.meta.url));
export const sourceFilePattern = /^[a-f0-9]{64}\.(html|pdf|json)$/;
export async function buildManufacturers({
  outputDir = join(appRoot, "knowledge/generated/manufacturers"),
} = {}) {
  const manifest = JSON.parse(
    await readFile(join(appRoot, "knowledge/manufacturer-sources.json"), "utf8"),
  );
  const cache = join(appRoot, "knowledge/sources/manufacturers");
  const profiles = await loadIntegrationProfiles();
  const adapterHash = sha(
    Buffer.concat(
      await Promise.all(
        [
          "scripts/manufacturer-catalogue.mjs",
          "scripts/manufacturer-adapters.mjs",
          "scripts/manufacturer-pdf-adapters.mjs",
          ...adapterFiles,
          "scripts/catalogue-html.mjs",
          "scripts/pdf-tables.py",
          "scripts/pdf-lines.py",
          "scripts/import-knowledge.mjs",
          "scripts/sam-catalogue.mjs",
          "src/knowledge.ts",
          "scripts/integration-profiles.mjs",
          "knowledge/integration-profiles.json",
          "knowledge/reviewed-monitors.jsonl",
        ].map((path) => readFile(join(appRoot, path))),
      ),
    ),
  );
  const revision = sha(JSON.stringify({ manifest, adapterHash }));
  const all = [],
    rejected = [],
    sourceCounts = [];
  for (const entry of manifest.entries) {
    if (!sourceFilePattern.test(entry.file)) throw new Error("Invalid source filename");
    const raw = await readFile(join(cache, entry.file));
    if (raw.length !== entry.bytes || sha(raw) !== entry.sha256)
      throw new Error(`Source hash mismatch: ${entry.url}`);
    const adapter = adapters[entry.adapter];
    if (!adapter?.records) throw new Error(`Unknown adapter: ${entry.adapter}`);
    try {
      let records;
      if (entry.file.endsWith(".pdf")) {
        // Ruled tables by cell geometry, or text lines by position: the adapter says which it reads.
        const script =
          adapter.extract === "lines" ? "scripts/pdf-lines.py" : "scripts/pdf-tables.py";
        const extractedPath = join(
          cache,
          `${entry.sha256}-${sha(await readFile(join(appRoot, script)))}.${adapter.extract === "lines" ? "lines" : "tables"}.json`,
        );
        let json;
        try {
          json = await readFile(extractedPath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          const result = await run(
            process.env.BUDDY_PYTHON ?? "python3",
            [join(appRoot, script), join(cache, entry.file)],
            { timeout: 120_000, maxBuffer: 40 * 1024 * 1024 },
          );
          json = result.stdout;
          await writeFile(extractedPath, json);
        }
        records = adapter.records(JSON.parse(json), entry, manifest, revision);
      } else records = adapter.records(raw.toString("utf8"), entry, manifest, revision);
      // A feed page adapter returns its own per-product quarantine beside the records.
      if (!Array.isArray(records)) {
        rejected.push(
          ...records.rejected.map((r) => ({ adapter: entry.adapter, family: entry.family, ...r })),
        );
        records = records.records;
      }
      all.push(...records.map((record) => integrationFor(record, profiles)));
      sourceCounts.push({
        adapter: entry.adapter,
        url: entry.url,
        records: records.length,
        family: entry.family ?? "Rolls batteries",
      });
    } catch (error) {
      rejected.push({
        adapter: entry.adapter,
        model: entry.model,
        family: entry.family,
        url: entry.url,
        reason: error.message,
      });
    }
  }
  for (const line of (await readFile(join(appRoot, "knowledge/reviewed-monitors.jsonl"), "utf8"))
    .trim()
    .split("\n")) {
    const record = knowledgeRecordSchema.parse(JSON.parse(line));
    const profile = profiles["pzem-017"];
    if (!profile.evidence.some((e) => e.sha256 === record.source.sha256))
      throw new Error("Monitor source must match reviewed evidence");
    all.push(
      integrationFor(
        { ...record, id: `mfr-${revision.slice(0, 16)}-${sha(record.id).slice(0, 24)}` },
        profiles,
      ),
    );
  }
  const { accepted, conflicts, identicalDuplicates } = resolveDuplicates(all);
  if (!accepted.length) throw new Error("No validated manufacturer records");
  const counts = (select) =>
    accepted.reduce((result, record) => {
      const key = select(record);
      if (key !== undefined) result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {});
  const report = {
    revision,
    adapterHash,
    acceptedRecords: accepted.length,
    byKind: counts((r) => r.kind),
    byBrand: counts((r) => r.brand),
    batteryVoltageClasses: counts((r) =>
      r.kind === "battery"
        ? r.specifications.find((s) => s.name === "Voltage class")?.value
        : undefined,
    ),
    batteryChemistries: counts((r) =>
      r.kind === "battery"
        ? r.specifications.find((s) => s.name === "Chemistry")?.value
        : undefined,
    ),
    rejected,
    conflicts,
    identicalDuplicates,
    sourceCounts,
    inferenceCalls: 0,
    validation:
      "Manufacturer-published facts; source hash, exact identity, unit and consistency validation. Not independent testing or installed compatibility.",
  };
  const temporary = `${outputDir}.${process.pid}.tmp`,
    catalogue = { id: manifest.id, revision };
  await mkdir(temporary, { recursive: true });
  try {
    await writeFile(
      join(temporary, "records.jsonl"),
      accepted.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await writeFile(join(temporary, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const files = [];
    for (let i = 0; i < accepted.length; i += 300) {
      const name = `records-${String(files.length).padStart(4, "0")}.sql`;
      await writeFile(
        join(temporary, name),
        accepted
          .slice(i, i + 300)
          .map((r) => recordSql(r, catalogue))
          .join(""),
      );
      files.push(name);
    }
    await writeFile(
      join(temporary, "activate.sql"),
      activateCatalogueSql(catalogue, accepted.length, {
        ...catalogue,
        acceptedRecords: accepted.length,
        adapterHash,
      }),
    );
    await writeFile(
      join(temporary, "import.json"),
      JSON.stringify(
        { catalogue, expectedRecords: accepted.length, files: [...files, "activate.sql"] },
        null,
        2,
      ) + "\n",
    );
    const destination = join(outputDir, revision);
    await mkdir(outputDir, { recursive: true });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      await rm(temporary, { recursive: true, force: true });
    }
    return {
      directory: destination,
      catalogue: manifest.id,
      revision,
      records: accepted.length,
      byKind: report.byKind,
      byBrand: report.byBrand,
      rejected: rejected.length,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildManufacturers()));
