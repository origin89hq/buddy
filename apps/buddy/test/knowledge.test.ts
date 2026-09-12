import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { newInstallation } from "@origin89/buddy";
import { recordSql } from "../scripts/import-knowledge.mjs";
import {
  citedSources,
  identityKey,
  knowledgeLimits,
  knowledgeQuery,
  lookupKeys,
  selectKnowledge,
} from "../src/knowledge.ts";

const seed = JSON.parse(
  readFileSync(new URL("../knowledge/reviewed.jsonl", import.meta.url), "utf8"),
);
const schema = ["0001_equipment_knowledge.sql", "0002_catalogue_revisions.sql"]
  .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  db.exec(recordSql(seed));
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
test("retrieves S550 brand aliases and preserves the two discharge ratings", () => {
  const db = database();
  for (const text of [
    "My Rolls S550 batteries",
    "Surrette S-550 batteries",
    "Rolls Battery S 550",
  ]) {
    const context = lookup(db, text);
    assert.equal(context.records.length, 1, text);
    const ratings = context.records[0].specifications.filter((item) => item.unit === "Ah");
    assert.deepEqual(
      ratings.map((item) => item.value),
      [428, 556],
    );
    assert.match(ratings[0].conditions, /20-hour/);
    assert.match(ratings[1].conditions, /100-hour/);
  }
  db.close();
});
test("does not attach a rating to an unknown suffix, successor, wrong brand or bare model", () => {
  const db = database();
  for (const text of [
    "Rolls S550X",
    "Rolls S-550/24",
    "Rolls S6 L16-HC",
    "Trojan S550",
    "My S550 batteries",
  ]) {
    assert.equal(lookup(db, text).records.length, 0, text);
  }
  db.close();
});
test("conflicting revisions and staged/withdrawn records fail closed", () => {
  const db = database();
  db.exec(recordSql({ ...seed, id: "rolls-s550-other-revision" }));
  assert.equal(lookup(db, "Rolls S550").records.length, 0);
  db.exec("DELETE FROM knowledge_aliases WHERE record_id='rolls-s550-other-revision'");
  for (const status of ["staged", "withdrawn"]) {
    db.prepare("UPDATE knowledge_records SET status=? WHERE id=?").run(status, seed.id);
    assert.equal(lookup(db, "Rolls S550").records.length, 0);
  }
  db.close();
});
test("repeat imports are idempotent and replace obsolete aliases", () => {
  const db = database();
  db.exec(recordSql(seed));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_records").get()!.n, 1);
  db.exec(recordSql({ ...seed, aliases: [] }));
  assert.equal(lookup(db, "Surrette S550").records.length, 0);
  assert.equal(lookup(db, "Rolls S550").records.length, 1);
  db.close();
});
test("requires reviewed provenance, parameterizes lookups and escapes imported literals", () => {
  assert.throws(() => recordSql({ ...seed, review: { ...seed.review, status: "draft" } }));
  assert.throws(() => recordSql({ ...seed, source: { ...seed.source, sha256: "missing" } }));
  assert.throws(() =>
    recordSql({ ...seed, source: { ...seed.source, url: "javascript:alert(1)" } }),
  );
  const db = database();
  db.exec(
    recordSql({
      ...seed,
      source: { ...seed.source, title: "Maker's data; DROP TABLE knowledge_records;" },
    }),
  );
  assert.equal(lookup(db, "Rolls S550").records.length, 1);
  assert.equal(db.prepare(knowledgeQuery(1)).all("' OR 1=1 --").length, 0);
  db.close();
});
test("bounded context includes only server-owned source links and leaves installation untouched", () => {
  const installation = newInstallation();
  const before = JSON.stringify(installation),
    rows = [],
    keys = [];
  for (let i = 0; i < 30; i++) {
    const record = { ...seed, id: `sample-${i}`, model: `M${i}`, aliases: [] };
    const key = identityKey(record.brand, record.model);
    keys.push(key);
    rows.push({ lookup_key: key, record_json: JSON.stringify(record) });
  }
  const context = selectKnowledge(rows, keys);
  assert.ok(context.truncated);
  assert.ok(context.records.length <= knowledgeLimits.records);
  assert.ok(JSON.stringify(context).length <= knowledgeLimits.contextCharacters);
  assert.deepEqual(citedSources(context, ["invented-source"]), []);
  assert.match(citedSources(context, [context.records[0].id])[0].url, /#page=1$/);
  assert.equal(JSON.stringify(installation), before);
  assert.ok(lookupKeys(installation, "Rolls S550 ".repeat(1000)).length <= knowledgeLimits.keys);
});
