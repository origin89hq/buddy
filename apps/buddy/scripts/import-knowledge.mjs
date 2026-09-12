import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { identityKey, knowledgeRecordSchema } from "../src/knowledge.ts";

const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
export function recordSql(input, catalogue) {
  const record = knowledgeRecordSchema.parse(input);
  const id = sqlString(record.id);
  const keys = [
    ...new Set([record, ...record.aliases].map((item) => identityKey(item.brand, item.model))),
  ];
  if (
    catalogue &&
    (!/^[a-z0-9-]{1,60}$/.test(catalogue.id) || !/^[a-f0-9]{64}$/.test(catalogue.revision))
  )
    throw new Error("Invalid catalogue revision");
  const catalogueId = catalogue ? sqlString(catalogue.id) : "NULL";
  const revision = catalogue ? sqlString(catalogue.revision) : "NULL";
  return (
    [
      `INSERT INTO knowledge_records(id,status,record_json,catalogue_id,catalogue_revision) VALUES(${id},'staged',${sqlString(JSON.stringify(record))},${catalogueId},${revision}) ON CONFLICT(id) DO UPDATE SET status='staged',record_json=excluded.record_json,catalogue_id=excluded.catalogue_id,catalogue_revision=excluded.catalogue_revision;`,
      `DELETE FROM knowledge_aliases WHERE record_id=${id};`,
      ...keys.map(
        (key) =>
          `INSERT INTO knowledge_aliases(lookup_key,record_id) VALUES(${sqlString(key)},${id});`,
      ),
      // An interrupted import cannot serve a partially updated record. Rerunning is idempotent.
      `UPDATE knowledge_records SET status='verified' WHERE id=${id};`,
    ].join("\n") + "\n"
  );
}

export function activateCatalogueSql(catalogue, expectedRecords, manifest) {
  if (
    !/^[a-z0-9-]{1,60}$/.test(catalogue.id) ||
    !/^[a-f0-9]{64}$/.test(catalogue.revision) ||
    !Number.isSafeInteger(expectedRecords) ||
    expectedRecords < 1
  )
    throw new Error("Invalid catalogue activation");
  const id = sqlString(catalogue.id),
    revision = sqlString(catalogue.revision);
  // One statement switches readers only after every record and its aliases were published.
  return `INSERT INTO knowledge_catalogues(id,active_revision,manifest_json)
SELECT ${id},${revision},${sqlString(JSON.stringify(manifest))}
WHERE (SELECT COUNT(*) FROM knowledge_records WHERE catalogue_id=${id} AND catalogue_revision=${revision} AND status='verified')=${expectedRecords}
ON CONFLICT(id) DO UPDATE SET active_revision=excluded.active_revision,manifest_json=excluded.manifest_json;\n`;
}

// Streaming compiler: no full-dataset read, LLM, database credentials or network requests.
export async function compileKnowledge(input, output) {
  if (resolve(input) === resolve(output)) throw new Error("Input and output must differ");
  const temporary = `${output}.${process.pid}.tmp`;
  const stream = createWriteStream(temporary, { flags: "wx" });
  // Observe early write errors even while processing the input stream.
  const completion = finished(stream);
  void completion.catch(() => {});
  let lineNumber = 0,
    records = 0;
  try {
    for await (const line of createInterface({
      input: createReadStream(input),
      crlfDelay: Infinity,
    })) {
      lineNumber++;
      if (!line.trim()) continue;
      if (line.length > 16000) throw new Error("Input record exceeds 16,000 characters");
      const sql = recordSql(JSON.parse(line));
      if (!stream.write(sql)) await once(stream, "drain");
      records++;
    }
    stream.end();
    await completion;
    await rename(temporary, output);
    return { records, output };
  } catch (error) {
    stream.destroy();
    await completion.catch(() => {});
    await rm(temporary, { force: true });
    throw new Error(`Knowledge import failed at line ${lineNumber}: ${error.message}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output] = process.argv;
  if (!input || !output)
    throw new Error("Usage: node scripts/import-knowledge.mjs reviewed.jsonl output.sql");
  console.log(JSON.stringify(await compileKnowledge(input, output)));
}
