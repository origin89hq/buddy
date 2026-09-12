import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { newInstallation } from "@origin89/buddy";
import { activateCatalogueSql, recordSql } from "../scripts/import-knowledge.mjs";
import { parseCsv, resolveDuplicates, samRecords } from "../scripts/sam-catalogue.mjs";
import { citedSources, knowledgeQuery, lookupKeys, selectKnowledge } from "../src/knowledge.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../knowledge/sam-sources.json", import.meta.url), "utf8"),
);
const panel = readFileSync(new URL("./fixtures/sam-module.csv", import.meta.url), "utf8");
const inverter = readFileSync(new URL("./fixtures/sam-inverter.csv", import.meta.url), "utf8");
const revision = "a".repeat(64);
function parse(text = panel, kind = "solar-panel") {
  return samRecords(
    text,
    { ...manifest.files.find((file: { kind: string }) => file.kind === kind), data_rows: 1 },
    manifest,
    revision,
  );
}
function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_equipment_knowledge.sql", "0002_catalogue_revisions.sql"])
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  return db;
}
function lookup(db: DatabaseSync, text: string) {
  const keys = lookupKeys(newInstallation(), text);
  return selectKnowledge(
    db.prepare(knowledgeQuery(keys.length)).all(...keys) as {
      lookup_key: string;
      record_json: string;
    }[],
    keys,
  );
}
test("CSV parsing preserves commas, escaped quotes, CRLF, multiline fields and trailing empty cells", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b,c\r\n"Maker, Inc","A""12","two\nlines"\r\nx,y,'), [
    ["a", "b", "c"],
    ["Maker, Inc", 'A"12', "two\nlines"],
    ["x", "y", ""],
  ]);
  for (const malformed of ['"unfinished', 'a"b,c', '"closed"garbage,b'])
    assert.throws(() => parseCsv(malformed));
});
test("real SAM sample retains amperes, STC conditions, full model and immutable source provenance", () => {
  const result = parse();
  assert.equal(result.rejected.length, 0);
  const record = result.records[0];
  assert.equal(record.brand, "Ablytek");
  assert.equal(record.model, "6MN6A270");
  assert.equal(
    record.specifications.find((field: { name: string }) => field.name === "Maximum-power current")
      .value,
    8.81,
  );
  assert.equal(
    record.specifications.find((field: { name: string }) => field.name === "Short-circuit current")
      .value,
    9.34,
  );
  assert.ok(
    record.specifications.every((field: { conditions: string }) =>
      field.conditions.includes("25°C"),
    ),
  );
  assert.equal(record.source.row, 4);
  assert.equal(record.source.page, undefined);
  assert.ok(record.source.url.includes(manifest.commit));
  assert.equal(record.source.type, "component-catalogue");
});
test("schema drift, unit drift and row-count drift abort an import; invalid ratings are quarantined", () => {
  assert.throws(() => parse(panel.replace("I_sc_ref", "new_column")), /columns/);
  assert.throws(() => parse(panel.replace(",A,V,A,V,", ",mA,V,A,V,")), /unit/);
  assert.throws(() => parse(panel + panel.split("\n")[3] + "\n"), /Row count/);
  for (const corrupted of [
    panel.replace(",9.34,38.63,", ",,38.63,"),
    panel.replace(",270,242.1,", ",2700,242.1,"),
    panel.replace(",9.34,38.63,", ",-9.34,38.63,"),
  ]) {
    const result = parse(corrupted);
    assert.equal(result.records.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].key, "Rejected identity must block any otherwise-valid duplicate");
  }
});
test("identical duplicates collapse; conflicting ratings and normalized-name collisions never pick a winner", () => {
  const record = parse().records[0];
  assert.equal(resolveDuplicates([record, structuredClone(record)]).identicalDuplicates, 1);
  const conflict = structuredClone(record);
  conflict.specifications[0].value = 999;
  assert.equal(resolveDuplicates([record, conflict]).accepted.length, 0);
  assert.equal(resolveDuplicates([record, { ...record, model: "6MN6A-270" }]).conflicts.length, 1);
});
test("inverter lookup requires the AC variant and CSV citations do not become PDF page links", () => {
  const db = database(),
    record = parse(inverter, "inverter").records[0];
  db.exec(recordSql(record));
  assert.equal(lookup(db, "ABB PVI-30-OUTD-S-US-A").records.length, 0);
  assert.equal(lookup(db, "ABB PVI-30-OUTD-S-US-A {480V}").records.length, 0);
  const found = lookup(db, "ABB PVI-30-OUTD-S-US-A {208V}.");
  assert.equal(found.records.length, 1);
  const source = citedSources(found, [record.id])[0];
  assert.equal(source.row, 4);
  assert.equal(source.page, undefined);
  assert.ok(!source.url.includes("#page="));
  assert.equal(lookup(db, "Ablytek PVI-30-OUTD-S-US-A {208V}").records.length, 0);
  db.close();
});
test("partial revision remains hidden, activation removes stale identities, manual records survive and replay is idempotent", () => {
  const db = database(),
    record = parse().records[0];
  const old = { id: "sam-cec", revision },
    next = { id: "sam-cec", revision: "b".repeat(64) };
  const manual = JSON.parse(
    readFileSync(new URL("../knowledge/reviewed.jsonl", import.meta.url), "utf8"),
  );
  db.exec(recordSql(manual));
  db.exec(recordSql(record, old));
  assert.equal(lookup(db, "Ablytek 6MN6A270").records.length, 0);
  db.exec(activateCatalogueSql(old, 1, {}));
  assert.equal(lookup(db, "Ablytek 6MN6A270").records.length, 1);
  const replacement = {
    ...record,
    id: "replacement-panel",
    specifications: [{ ...record.specifications[0], value: 271 }],
  };
  const newModel = { ...record, id: "new-panel", model: "NEW123" };
  db.exec(recordSql(replacement, next));
  db.exec(activateCatalogueSql(next, 2, {}));
  assert.equal(lookup(db, "Ablytek 6MN6A270").records[0].specifications[0].value, 270);
  db.exec(recordSql(newModel, next));
  db.exec(activateCatalogueSql(next, 2, {}));
  assert.equal(lookup(db, "Ablytek 6MN6A270").records[0].specifications[0].value, 271);
  db.exec(recordSql(newModel, next));
  db.exec(activateCatalogueSql(next, 2, {}));
  assert.equal(lookup(db, "Ablytek NEW123").records.length, 1);
  assert.equal(lookup(db, "Rolls S550").records.length, 1);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_records WHERE catalogue_revision=?")
      .get(next.revision)!.n,
    2,
  );
  const final = { id: "sam-cec", revision: "c".repeat(64) };
  db.exec(recordSql({ ...newModel, id: "final-panel" }, final));
  db.exec(activateCatalogueSql(final, 1, {}));
  assert.equal(lookup(db, "Ablytek 6MN6A270").records.length, 0);
  assert.equal(lookup(db, "Ablytek NEW123").records.length, 1);
  db.close();
});
