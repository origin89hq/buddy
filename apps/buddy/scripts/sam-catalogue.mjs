import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identityKey, knowledgeRecordSchema } from "../src/knowledge.ts";
import { activateCatalogueSql, recordSql } from "./import-knowledge.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const maxFileBytes = 10 * 1024 * 1024;
const appRoot = fileURLToPath(new URL("../", import.meta.url));

// Strict CSV parsing, including quoted commas, escaped quotes and multiline fields.
export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (i === 0 && char === "\uFEFF") continue;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
      continue;
    }
    if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("Malformed CSV quoting");
      field += char;
    }
  }
  if (quoted) throw new Error("Unterminated CSV field");
  if (row.length || field || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const panelFields = [
  ["STC", "Rated power", "W"],
  ["I_sc_ref", "Short-circuit current", "A"],
  ["V_oc_ref", "Open-circuit voltage", "V"],
  ["I_mp_ref", "Maximum-power current", "A"],
  ["V_mp_ref", "Maximum-power voltage", "V"],
];
const inverterFields = [
  ["Vac", "AC voltage variant", "V"],
  ["Paco", "Rated AC power", "W"],
  ["Vdcmax", "Catalogue maximum DC voltage", "V"],
  ["Idcmax", "Catalogue maximum DC current", "A"],
  ["Mppt_low", "MPPT minimum voltage", "V"],
  ["Mppt_high", "MPPT maximum voltage", "V"],
];

export function samRecords(csv, file, manifest, revision) {
  const rows = parseCsv(csv);
  const fields = file.kind === "solar-panel" ? panelFields : inverterFields;
  const required = [
    "Name",
    ...(file.kind === "solar-panel" ? ["Manufacturer", "Technology"] : []),
    ...fields.map(([column]) => column),
  ];
  const header = rows[0];
  if (!header || required.some((column) => header.filter((name) => name === column).length !== 1))
    throw new Error(`Unexpected ${file.name} columns`);
  if (rows[1]?.[0] !== "Units" || rows[2]?.[0] !== "[0]")
    throw new Error(`Missing ${file.name} metadata rows`);
  for (const [column, , unit] of fields) {
    const actual = rows[1][header.indexOf(column)];
    // SAM leaves STC's unit empty; its documented column is watts at STC.
    if (actual !== unit && !(column === "STC" && actual === ""))
      throw new Error(`Unexpected unit for ${column}: ${actual}`);
  }
  const records = [],
    rejected = [];
  let dataRows = 0;
  for (let index = 3; index < rows.length; index++) {
    const row = rows[index];
    if (!row.some((value) => value.trim())) continue;
    dataRows++;
    const get = (column) => (row[header.indexOf(column)] ?? "").trim();
    let key;
    try {
      if (row.length !== header.length) throw new Error("Column count differs from header");
      let brand, model;
      if (file.kind === "solar-panel") {
        brand = get("Manufacturer");
        if (!brand || !get("Name").startsWith(`${brand} `))
          throw new Error("Manufacturer does not match full product name");
        model = get("Name")
          .slice(brand.length + 1)
          .trim();
      } else {
        const separator = get("Name").indexOf(":");
        if (separator < 1) throw new Error("Missing manufacturer separator");
        brand = get("Name").slice(0, separator).trim();
        model = get("Name")
          .slice(separator + 1)
          .trim();
      }
      if (!model || !/\d/.test(model)) throw new Error("Missing exact model identifier");
      key = identityKey(brand, model);
      const specifications = fields.map(([column, name, unit]) => {
        const raw = get(column);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
          throw new Error(`Missing or invalid ${column}`);
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`Nonpositive ${column}`);
        return {
          name,
          value,
          unit,
          conditions:
            file.kind === "solar-panel"
              ? "SAM CEC catalogue rating at STC: 1000 W/m² irradiance, 25°C cell temperature, AM1.5 spectrum. Not measured installation output."
              : `SAM CEC inverter catalogue, ${get("Vac")} V AC variant. Modelling data; verify the manufacturer manual before electrical design.`,
        };
      });
      const values = Object.fromEntries(
        fields.map(([column], i) => [column, specifications[i].value]),
      );
      if (
        file.kind === "solar-panel" &&
        (values.I_mp_ref > values.I_sc_ref ||
          values.V_mp_ref >= values.V_oc_ref ||
          Math.abs(values.I_mp_ref * values.V_mp_ref - values.STC) / values.STC > 0.03)
      )
        throw new Error("Inconsistent panel operating-point ratings");
      if (
        file.kind === "inverter" &&
        (values.Mppt_low > values.Mppt_high || values.Mppt_high > values.Vdcmax)
      )
        throw new Error("Inconsistent inverter voltage range");
      const sourceUrl = `https://github.com/NatLabRockies/SAM/blob/${manifest.commit}/deploy/libraries/${encodeURIComponent(file.name)}`;
      const record = knowledgeRecordSchema.parse({
        id: `sam-${revision.slice(0, 16)}-${hash(`${file.kind}:${identityKey(brand, model)}`).slice(0, 24)}`,
        brand,
        model,
        kind: file.kind,
        aliases: [],
        review: {
          status: "verified",
          checkedAt: manifest.checkedAt,
          reviewedBy: "SAM adapter: pinned source, schema, unit and consistency checks",
        },
        source: {
          type: "component-catalogue",
          title: `SAM ${file.name}`,
          url: sourceUrl,
          row: index + 1,
          revision: `SAM ${manifest.commit.slice(0, 12)}`,
          sha256: file.sha256,
        },
        specifications,
        limitations: [
          "Imported catalogue values; validation is not independent testing or a manufacturer compatibility guarantee.",
          "An exact model and electrical variant match is required. Specifications do not establish installed wiring, live output or equipment condition.",
          "Charging settings, maintenance instructions and Origin89 driver support are not established by this record.",
        ],
      });
      records.push(record);
    } catch (error) {
      rejected.push({
        file: file.name,
        row: index + 1,
        name: get("Name"),
        ...(key ? { key } : {}),
        reason: error.message,
      });
    }
  }
  if (dataRows !== file.data_rows)
    throw new Error(`Row count changed for ${file.name}: ${dataRows} != ${file.data_rows}`);
  return { records, rejected, dataRows };
}

export function resolveDuplicates(records) {
  const groups = new Map();
  for (const record of records) {
    const key = identityKey(record.brand, record.model);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const accepted = [],
    conflicts = [];
  let identicalDuplicates = 0;
  for (const [key, group] of groups) {
    const signature = (record) =>
      JSON.stringify([record.brand, record.model, record.kind, record.specifications]);
    if (group.every((record) => signature(record) === signature(group[0]))) {
      accepted.push(group[0]);
      identicalDuplicates += group.length - 1;
    } else
      conflicts.push({
        key,
        models: group.map(({ brand, model, source }) => ({ brand, model, source })),
      });
  }
  return { accepted, conflicts, identicalDuplicates };
}

async function sourceFile(path, url, expectedHash, offline) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT" || offline) throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`Source HTTP ${response.status}: ${url}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxFileBytes) throw new Error("Source exceeds download bound");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    if (hash(bytes) !== expectedHash) throw new Error(`Source hash mismatch: ${path}`);
    await writeFile(path, bytes, { flag: "wx" });
  }
  if (bytes.length > maxFileBytes || hash(bytes) !== expectedHash)
    throw new Error(`Source hash mismatch: ${path}`);
  return bytes;
}

export async function buildSam({
  sourceDir = join(appRoot, "knowledge/sources/sam"),
  outputDir = join(appRoot, "knowledge/generated/sam"),
  offline = false,
} = {}) {
  const manifest = JSON.parse(await readFile(join(appRoot, "knowledge/sam-sources.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(manifest.commit))
    throw new Error("SAM source must use an immutable commit");
  const adapterHash = hash(
    Buffer.concat(
      await Promise.all([
        readFile(fileURLToPath(import.meta.url)),
        readFile(join(appRoot, "scripts/import-knowledge.mjs")),
        readFile(join(appRoot, "src/knowledge.ts")),
      ]),
    ),
  );
  const revision = hash(JSON.stringify({ manifest, adapterHash }));
  const temporary = `${outputDir}.${process.pid}.tmp`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(temporary, { recursive: true });
  try {
    const license = await sourceFile(
      join(sourceDir, "LICENSE"),
      `https://raw.githubusercontent.com/NatLabRockies/SAM/${manifest.commit}/LICENSE`,
      manifest.license.sha256,
      offline,
    );
    const all = [],
      rejected = [],
      files = [];
    for (const file of manifest.files) {
      const rawUrl = `https://raw.githubusercontent.com/NatLabRockies/SAM/${manifest.commit}/deploy/libraries/${encodeURIComponent(file.name)}`;
      const bytes = await sourceFile(join(sourceDir, file.name), rawUrl, file.sha256, offline);
      if (bytes.length !== file.bytes) throw new Error(`Source byte count mismatch: ${file.name}`);
      const parsed = samRecords(bytes.toString("utf8"), file, manifest, revision);
      all.push(...parsed.records);
      rejected.push(...parsed.rejected);
      files.push({
        ...file,
        url: rawUrl,
        parsedRows: parsed.dataRows,
        validatedRows: parsed.records.length,
        rejectedRows: parsed.rejected.length,
      });
    }
    const rejectedKeys = new Set(rejected.map((row) => row.key).filter(Boolean));
    const { accepted, conflicts, identicalDuplicates } = resolveDuplicates(
      all.filter((record) => !rejectedKeys.has(identityKey(record.brand, record.model))),
    );
    if (!accepted.length) throw new Error("No importable records");
    const report = {
      catalogue: manifest.id,
      revision,
      adapterHash,
      sourceCommit: manifest.commit,
      checkedAt: manifest.checkedAt,
      files,
      acceptedRecords: accepted.length,
      identicalDuplicates,
      conflicts,
      rejected,
      validation: "Source hash/schema/unit/consistency checks; not independent equipment testing.",
      inferenceCalls: 0,
    };
    await writeFile(
      join(temporary, "records.jsonl"),
      accepted.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await writeFile(join(temporary, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(temporary, "LICENSE-SAM.txt"), license);
    const catalogue = { id: manifest.id, revision };
    // Bounded SQL files avoid one huge statement and keep local Wrangler imports manageable.
    const chunks = [];
    for (let offset = 0; offset < accepted.length; offset += 500) {
      const filename = `records-${String(chunks.length).padStart(4, "0")}.sql`;
      await writeFile(
        join(temporary, filename),
        accepted
          .slice(offset, offset + 500)
          .map((record) => recordSql(record, catalogue))
          .join(""),
      );
      chunks.push(filename);
    }
    const activation = "activate.sql";
    await writeFile(
      join(temporary, activation),
      activateCatalogueSql(catalogue, accepted.length, {
        revision,
        files,
        acceptedRecords: accepted.length,
      }),
    );
    await writeFile(
      join(temporary, "import.json"),
      JSON.stringify(
        { catalogue, expectedRecords: accepted.length, files: [...chunks, activation] },
        null,
        2,
      ) + "\n",
    );
    // A completed revision gets its own immutable output directory; reruns may reuse it.
    const destination = join(outputDir, revision);
    await mkdir(outputDir, { recursive: true });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
    return {
      directory: destination,
      revision,
      records: accepted.length,
      rejectedRows: rejected.length,
      conflictingIdentities: conflicts.length,
      identicalDuplicates,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--offline"))
    throw new Error("Usage: node scripts/sam-catalogue.mjs [--offline]");
  console.log(JSON.stringify(await buildSam({ offline: args.includes("--offline") })));
}
