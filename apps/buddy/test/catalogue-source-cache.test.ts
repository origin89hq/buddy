import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { packSources, restoreSources, sourcePlan } from "../scripts/catalogue-source-cache.mjs";

test("source archive restores exact binary bytes and checks every file before replacing the cache", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "buddy-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    destination = join(root, "restored"),
    archive = join(root, "sources.gz");
  const bytes = Buffer.from([0, 1, 255, 10, 36]);
  await mkdir(join(source, "sam"), { recursive: true });
  await writeFile(join(source, "sam/LICENSE"), bytes);
  const plan = {
    key: "sources/test.jsonl.gz",
    files: [
      {
        path: "sam/LICENSE",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  await packSources(plan, source, archive);
  await restoreSources(plan, archive, destination);
  assert.deepEqual(await readFile(join(destination, "sam/LICENSE")), bytes);
  for (const entries of [
    [],
    [{ path: "../../escape", data: bytes.toString("base64") }],
    [{ path: "sam/LICENSE", data: "wrong" }],
    [
      { path: "sam/LICENSE", data: bytes.toString("base64") },
      { path: "sam/LICENSE", data: bytes.toString("base64") },
    ],
  ]) {
    await writeFile(
      archive,
      gzipSync(
        entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
      ),
    );
    await assert.rejects(restoreSources(plan, archive, destination));
    assert.deepEqual(await readFile(join(destination, "sam/LICENSE")), bytes);
    assert.ok(!(await readdir(root)).some((file) => file.startsWith("sources-restore-")));
  }
});

test("the source archive key is deterministic and covers all committed source manifests", async () => {
  const a = await sourcePlan(),
    b = await sourcePlan();
  assert.equal(a.key, b.key);
  assert.match(a.key, /^sources\/[a-f0-9]{64}\.jsonl.gz$/);
  assert.ok(a.files.some((file: { path: string }) => file.path === "sam/LICENSE"));
  assert.ok(a.files.some((file: { path: string }) => file.path.startsWith("cec-batteries/")));
  assert.ok(a.files.some((file: { path: string }) => file.path.startsWith("manufacturers/")));
  assert.equal(new Set(a.files.map((file: { path: string }) => file.path)).size, a.files.length);
});

test("source restore replaces the complete cache and recovers interrupted directory switches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "buddy-source-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    destination = join(root, "cache"),
    archive = join(root, "sources.gz");
  const backup = `${destination}.restore-backup`;
  const files = ["sam/LICENSE", "manufacturers/controller.pdf"];
  const plan = {
    key: "sources/test.jsonl.gz",
    files: files.map((path) => {
      const bytes = Buffer.from(`new ${path}`);
      return {
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  };
  for (const path of files) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(source, path), `new ${path}`);
    await writeFile(join(destination, path), `old ${path}`);
  }
  await writeFile(join(destination, "obsolete.pdf"), "obsolete");
  await packSources(plan, source, archive);

  // Reproduce a process killed after moving the old cache aside. Recovery must
  // restore every old file even if the next supplied archive is invalid.
  await rename(destination, backup);
  const invalid = join(root, "invalid.gz");
  await writeFile(invalid, gzipSync(""));
  await assert.rejects(restoreSources(plan, invalid, destination), /Incomplete source archive/);
  for (const path of files)
    assert.equal(await readFile(join(destination, path), "utf8"), `old ${path}`);
  assert.equal(await readFile(join(destination, "obsolete.pdf"), "utf8"), "obsolete");
  assert.ok(!(await readdir(root)).includes("cache.restore-backup"));

  await restoreSources(plan, archive, destination);
  for (const path of files)
    assert.equal(await readFile(join(destination, path), "utf8"), `new ${path}`);
  await assert.rejects(readFile(join(destination, "obsolete.pdf")), { code: "ENOENT" });

  // Reproduce a process killed after installation but before backup cleanup.
  // Recovery must retain the new cache rather than rolling it back.
  await mkdir(join(backup, "sam"), { recursive: true });
  await writeFile(join(backup, "sam/LICENSE"), "old licence");
  await assert.rejects(restoreSources(plan, invalid, destination), /Incomplete source archive/);
  for (const path of files)
    assert.equal(await readFile(join(destination, path), "utf8"), `new ${path}`);
  assert.ok(!(await readdir(root)).includes("cache.restore-backup"));
  assert.ok(!(await readdir(root)).some((file) => file.startsWith("sources-restore-")));
});
