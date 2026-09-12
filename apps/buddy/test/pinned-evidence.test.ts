import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadIntegrationProfiles } from "../scripts/integration-profiles.mjs";

test("integration profiles require the pinned controller evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "buddy-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new URL("../knowledge/evidence/", import.meta.url);
  await cp(original, root, { recursive: true });
  assert.ok(Object.keys(await loadIntegrationProfiles(root)).length > 0);
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const path = "crates/o89-core/src/dialects.rs";
  const pin = manifest.files[path];
  for (const invalid of [
    undefined,
    { ...pin, sha256: "0".repeat(64) },
    { ...pin, archive: "../controller-dialects.rs" },
  ]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, files: { [path]: invalid } }));
    await assert.rejects(loadIntegrationProfiles(root), /Missing pinned controller evidence/);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(root, pin.archive), "altered evidence");
  await assert.rejects(loadIntegrationProfiles(root), /Integration evidence changed/);
  await rm(join(root, pin.archive));
  await assert.rejects(loadIntegrationProfiles(root), /ENOENT/);
});
