import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { identityKey, knowledgeRecordSchema } from "../src/knowledge.ts";
import { activateCatalogueSql, recordSql } from "./import-knowledge.mjs";
import { sha, spec } from "./manufacturer-adapters.mjs";
import { resolveDuplicates } from "./sam-catalogue.mjs";

const app = fileURLToPath(new URL("../", import.meta.url)),
  run = promisify(execFile);
export const cecHeaders = [
  "Manufacturer Name",
  "Brand1",
  "Model Number",
  "Technology",
  "Description",
  "UL 1973 Certification",
  null,
  null,
  "Nameplate Energy Capacity",
  "Maximum Continuous Discharge Rate2",
  "Manufacturer Declared Roundtrip Efficiency",
  "Certified JA12 Control  Strategies1",
  "Declaration for JA12 Submitted1",
  "Notes",
  "CEC Listing Date",
  "Last Update",
];
export const cecUnits = [
  null,
  null,
  null,
  null,
  null,
  "Certifying Entity",
  "Certificate Date (mm/dd/yyyy)",
  "Edition of UL 1973",
  "(kWh)",
  "(kW)",
  "(%, Ac-AC)1",
  null,
  null,
  null,
  "(mm/dd/yyyy)",
  "(mm/dd/yyyy)",
];
const positive = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`Invalid ${name}`);
  return value;
};
export function parseCecBatteries(input, manifest, revision) {
  if (
    input.sheet !== "Battery" ||
    JSON.stringify(input.rows[10]) !== JSON.stringify(cecHeaders) ||
    JSON.stringify(input.rows[11]) !== JSON.stringify(cecUnits)
  )
    throw new Error("CEC sheet, header or units changed");
  if (input.rows[1][0] !== manifest.dataNotice || input.rows.length - 12 !== manifest.expectedRows)
    throw new Error("CEC source revision or row count changed");
  const records = [],
    rejected = [];
  for (let index = 12; index < input.rows.length; index++) {
    const row = input.rows[index],
      physicalRow = index + 1;
    try {
      if (row.length !== 16) throw new Error("Invalid row width");
      const [brand, , model, technology] = row;
      if (
        typeof brand !== "string" ||
        typeof model !== "string" ||
        typeof technology !== "string" ||
        !brand.trim() ||
        !model.trim()
      )
        throw new Error("Missing identity");
      const specifications = [
        spec(
          "Nameplate energy capacity",
          positive(row[8], "kWh"),
          "kWh",
          "CEC nameplate energy rating; not usable energy, present charge, or Ah. Discharge test conditions are not supplied.",
        ),
        spec(
          "Battery technology (CEC wording)",
          technology,
          null,
          "Preserved source classification; incomplete chemistry descriptions are not expanded.",
        ),
      ];
      if (row[9] !== null)
        specifications.push(
          spec(
            "Maximum continuous discharge power",
            positive(row[9], "kW"),
            "kW",
            "Manufacturer-declared value reported by CEC; temperature, voltage and duration conditions are not supplied. Not charging current or surge power.",
          ),
        );
      const record = knowledgeRecordSchema.parse({
        id: `cec-bat-${revision.slice(0, 16)}-${sha(identityKey(brand, model)).slice(0, 24)}`,
        brand: brand.trim(),
        model: model.trim(),
        kind: "battery",
        aliases: [],
        review: {
          status: "verified",
          checkedAt: manifest.checkedAt,
          reviewedBy: "CEC source hash, exact worksheet columns, units and record validation",
        },
        source: {
          type: "component-catalogue",
          title: "California Energy Commission Battery List · Battery worksheet",
          url: manifest.url,
          row: physicalRow,
          revision: manifest.dataRevision,
          sha256: manifest.sha256,
        },
        specifications,
        certifications: [
          {
            standard: "UL 1973",
            edition: row[7],
            certifyingBody: row[5],
            certificateDate: row[6],
            evidence: "catalogue-reported",
          },
        ],
        limitations: [
          "CEC catalogue facts, not independent product testing, a current certificate verification or Origin89 support.",
          "Nominal voltage, Ah, charge/discharge current and connection ports are not supplied. Do not infer them from the model name.",
          "UL 1973 names the standard; the recorded certifying body may be another organisation. Canadian certification scope is not supplied.",
          ...(row[9] === null
            ? ["Maximum continuous discharge power was not supplied in the source."]
            : []),
        ],
      });
      records.push(record);
    } catch (error) {
      rejected.push({ row: physicalRow, brand: row[0], model: row[2], reason: error.message });
    }
  }
  return { records, rejected };
}

export async function buildCecBatteries({
  offline = false,
  outputDir = join(app, "knowledge/generated/cec-batteries"),
} = {}) {
  const manifest = JSON.parse(
    await readFile(join(app, "knowledge/cec-batteries-source.json"), "utf8"),
  );
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Invalid source hash");
  const sourceDir = join(app, "knowledge/sources/cec-batteries"),
    path = join(sourceDir, `${manifest.sha256}.xlsx`);
  await mkdir(sourceDir, { recursive: true });
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT" || offline) throw error;
    const response = await fetch(manifest.downloadUrl, { signal: AbortSignal.timeout(40000) });
    if (!response.ok || !response.body) throw new Error(`CEC download HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) throw new Error("CEC workbook too large");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    if (sha(bytes) !== manifest.sha256)
      throw new Error("CEC download changed; review a new snapshot instead of accepting new bytes");
    await writeFile(path, bytes);
  }
  if (bytes.length !== manifest.bytes || sha(bytes) !== manifest.sha256)
    throw new Error("CEC source bytes do not match manifest");
  const adapterHash = sha(
    Buffer.concat(
      await Promise.all(
        [
          "scripts/cec-batteries.mjs",
          "scripts/read-cec-batteries.py",
          "scripts/import-knowledge.mjs",
          "scripts/sam-catalogue.mjs",
          "scripts/manufacturer-adapters.mjs",
          "src/knowledge.ts",
        ].map((p) => readFile(join(app, p))),
      ),
    ),
  );
  const revision = sha(JSON.stringify({ manifest, adapterHash }));
  const extracted = await run(
    process.env.BUDDY_PYTHON ?? "python3",
    [join(app, "scripts/read-cec-batteries.py"), path],
    { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
  );
  const parsed = parseCecBatteries(JSON.parse(extracted.stdout), manifest, revision);
  const { accepted, conflicts, identicalDuplicates } = resolveDuplicates(parsed.records);
  if (!accepted.length) throw new Error("No validated CEC batteries");
  const temporary = `${outputDir}.${process.pid}.tmp`,
    catalogue = { id: "cec-batteries", revision };
  await mkdir(temporary, { recursive: true });
  try {
    const counts = (fn) =>
      accepted.reduce((map, r) => {
        const k = fn(r);
        map[k] = (map[k] ?? 0) + 1;
        return map;
      }, {});
    const report = {
      catalogue,
      adapterHash,
      source: manifest,
      acceptedRecords: accepted.length,
      byManufacturer: counts((r) => r.brand),
      byTechnology: counts((r) => r.specifications[1].value),
      missingDischargePower: accepted.filter((r) => !r.specifications.some((s) => s.unit === "kW"))
        .length,
      rejected: parsed.rejected,
      conflicts,
      identicalDuplicates,
      inferenceCalls: 0,
      aliasPolicy:
        "Brand1 is preserved in the raw workbook; no unreviewed brand aliases or corporate-name equivalences are added.",
    };
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
        expectedRecords: accepted.length,
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
      revision,
      records: accepted.length,
      rejectedRows: parsed.rejected.length,
      conflicts: conflicts.length,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--offline"))
    throw new Error("Use --offline or no arguments");
  console.log(
    JSON.stringify(await buildCecBatteries({ offline: process.argv.includes("--offline") })),
  );
}
