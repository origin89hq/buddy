-- Public manufacturer knowledge only. Private installation state stays in its session DO.
CREATE TABLE knowledge_records (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('staged', 'verified', 'withdrawn')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND length(record_json) <= 12000)
);
CREATE TABLE knowledge_aliases (
  lookup_key TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES knowledge_records(id),
  PRIMARY KEY (lookup_key, record_id)
) WITHOUT ROWID;
CREATE INDEX knowledge_aliases_record ON knowledge_aliases(record_id);
