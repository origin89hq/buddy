-- Build a complete revision before switching the one active pointer.
-- Older revisions remain available for rollback; manual records have NULL catalogue fields.
CREATE TABLE knowledge_catalogues (
  id TEXT PRIMARY KEY,
  active_revision TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json))
);
ALTER TABLE knowledge_records ADD COLUMN catalogue_id TEXT;
ALTER TABLE knowledge_records ADD COLUMN catalogue_revision TEXT;
CREATE INDEX knowledge_records_catalogue ON knowledge_records(catalogue_id, catalogue_revision, status);
