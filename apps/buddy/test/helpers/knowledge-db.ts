import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { recordSql } from "../../scripts/import-knowledge.mjs";
import type { KnowledgeDatabase, KnowledgeRecord } from "../../src/knowledge.ts";

export const seed: KnowledgeRecord = JSON.parse(
  readFileSync(new URL("../../knowledge/reviewed.jsonl", import.meta.url), "utf8"),
);
export function knowledgeDatabase(records: KnowledgeRecord[] = [seed]) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_equipment_knowledge.sql", "0002_catalogue_revisions.sql"])
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  for (const record of records) sqlite.exec(recordSql(record));
  let queries = 0;
  const db: KnowledgeDatabase = {
    prepare(query) {
      return {
        bind(...values) {
          return {
            async all<T>() {
              queries++;
              return { results: sqlite.prepare(query).all(...values) as T[] };
            },
          };
        },
      };
    },
  };
  return { db, sqlite, queries: () => queries };
}
