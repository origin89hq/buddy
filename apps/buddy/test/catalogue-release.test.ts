import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ParseError, parse } from "jsonc-parser";
import {
  createBundle,
  publishBundle,
  verifyBundle,
  wranglerRunner,
} from "../scripts/catalogue-release.mjs";
import { buddyConfig } from "../scripts/deployment-config.mjs";

const original = JSON.parse(
  readFileSync(new URL("../knowledge/reviewed.jsonl", import.meta.url), "utf8"),
);
const commit = "a".repeat(40);

test("Wrangler file progress is accepted while command JSON and process failures remain checked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "buddy-wrangler-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "wrangler.mjs");
  await writeFile(
    executable,
    `
    if (process.argv.includes("failed.sql")) {
      console.error("D1 import failed"); process.exit(1);
    } else if (process.argv.includes("--file")) {
      console.log('├ Checking if file needs uploading\\n└ Upload complete\\n[{"success":true}]');
    } else if (process.argv.includes("malformed")) {
      console.log("unexpected query output");
    } else if (process.argv.includes("reported-error")) {
      console.log('[{"success":false,"error":"query failed"}]');
    } else {
      console.log('[{"success":true,"results":[{"records":250}]}]');
    }
  `,
  );
  const run = wranglerRunner("test-config.json", true, [process.execPath, executable]);
  assert.deepEqual(await run(["file", "batch.sql"]), []);
  assert.deepEqual(await run(["query", "count"]), [{ records: 250 }]);
  await assert.rejects(run(["file", "failed.sql"]), /D1 import failed/);
  await assert.rejects(run(["query", "malformed"]), SyntaxError);
  await assert.rejects(run(["query", "reported-error"]), /unsuccessful query/);
});

async function fixture(t: TestContext, suffix = "", ids = ["reviewed-equipment"]) {
  const root = await mkdtemp(join(tmpdir(), "buddy-publication-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input.jsonl"),
    report = join(root, "report.json"),
    bundle = join(root, "bundle");
  await writeFile(input, JSON.stringify({ ...original, model: original.model + suffix }) + "\n");
  await writeFile(report, JSON.stringify({ acceptedRecords: 1, rejected: [], conflicts: [] }));
  const release = await createBundle(
    ids.map((id) => ({ id, records: input, report })),
    bundle,
    commit,
  );
  return { root, bundle, release };
}
function database(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const operations: string[] = [];
  const run = async ([operation, value]: [string, string?]) => {
    operations.push(operation);
    if (operation === "migrate") {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_catalogues'").get()) {
        for (const file of ["0001_equipment_knowledge.sql", "0002_catalogue_revisions.sql"])
          db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      }
      return [];
    }
    if (operation === "file") {
      db.exec(await readFile(value!, "utf8"));
      return [];
    }
    return db.prepare(value!).all();
  };
  return { db, run, operations };
}
async function publish(
  f: Awaited<ReturnType<typeof fixture>>,
  run: ReturnType<typeof database>["run"],
) {
  return publishBundle(f.bundle, {
    expectedDigest: f.release.digest,
    sqlDirectory: join(f.root, "sql"),
    run,
  });
}

test("release publication uses real SQLite, ignores artifact SQL, preserves prior revisions and is idempotent", async (t) => {
  const first = await fixture(t),
    next = await fixture(t, " revised"),
    { db, run, operations } = database(t);
  await writeFile(join(first.bundle, "activate.sql"), "DROP TABLE knowledge_records;");
  await publish(first, run);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_records").get()!.n, 1);
  operations.length = 0;
  await publish(first, run);
  assert.ok(!operations.includes("file"), "Retry must not restage active records");
  await publish(next, run);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_records").get()!.n, 2);
  assert.equal(
    db.prepare("SELECT active_revision FROM knowledge_catalogues").get()!.active_revision,
    next.release.manifest.catalogues[0].revision,
  );
  assert.equal(db.prepare("SELECT COUNT(DISTINCT id) AS n FROM knowledge_records").get()!.n, 2);
});

test("an interrupted upload keeps the old revision active; retry finishes the staged revision", async (t) => {
  const first = await fixture(t),
    next = await fixture(t, " revised", ["reviewed-equipment", "cec-batteries"]),
    { db, run } = database(t);
  await publish(first, run);
  let files = 0;
  await assert.rejects(
    publish(next, async (args: [string, string?]) => {
      if (args[0] === "file" && ++files === 2) throw new Error("Simulated upload interruption");
      return run(args);
    }),
    /interruption/,
  );
  assert.equal(
    db
      .prepare("SELECT active_revision FROM knowledge_catalogues WHERE id='reviewed-equipment'")
      .get()!.active_revision,
    first.release.manifest.catalogues[0].revision,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_catalogues").get()!.n, 1);
  await publish(next, run);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_catalogues").get()!.n, 2);
});

test("all hashes, record counts, schemas and IDs are checked before any database call", async (t) => {
  for (const damage of ["data", "report", "count", "path", "duplicate", "schema", "digest"]) {
    const f = await fixture(t),
      manifestPath = join(f.bundle, "bundle.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const data = join(f.bundle, "reviewed-equipment/records.jsonl");
    if (damage === "data") await writeFile(data, "modified");
    if (damage === "report")
      await writeFile(join(f.bundle, "reviewed-equipment/report.json"), "modified");
    if (damage === "count") manifest.catalogues[0].records = 2;
    if (damage === "path") manifest.catalogues[0].id = "../../outside";
    if (damage === "duplicate" || damage === "schema") {
      const { createHash } = await import("node:crypto");
      const content =
        damage === "duplicate"
          ? (await readFile(data, "utf8")).repeat(2)
          : JSON.stringify({ ...original, review: { status: "unverified" } }) + "\n";
      await writeFile(data, content);
      manifest.catalogues[0].revision = createHash("sha256").update(content).digest("hex");
      if (damage === "duplicate") manifest.catalogues[0].records = 2;
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    let calls = 0;
    await assert.rejects(
      publishBundle(f.bundle, {
        expectedDigest: damage === "digest" ? "0".repeat(64) : undefined,
        sqlDirectory: join(f.root, "sql"),
        run: async () => {
          calls++;
          return [];
        },
      }),
    );
    assert.equal(calls, 0, damage);
  }
});

test("activation never happens when D1 has fewer staged records than the bundle", async (t) => {
  const f = await fixture(t),
    { db, run } = database(t);
  await assert.rejects(
    publish(f, async (args: [string, string?]) => (args[0] === "file" ? [] : run(args))),
    /Staged record count/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_catalogues").get()!.n, 0);
});

test("build hashes are deterministic and a changed report requires a new approval digest", async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  assert.equal(a.release.digest, b.release.digest);
  const report = join(b.bundle, "reviewed-equipment/report.json");
  await writeFile(report, "{}");
  await assert.rejects(verifyBundle(b.bundle), /checksum/);
});

test("the CLI accepts the approved sha256 argument and rejects misleading remote flags", async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL("../scripts/catalogue-release.mjs", import.meta.url));
  const result = execFileSync(
    process.execPath,
    [script, "verify", `--bundle=${f.bundle}`, `--expect-sha256=${f.release.digest}`],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(result).digest, f.release.digest);
  assert.throws(
    () => execFileSync(process.execPath, [script, "publish", "--remote=false"], { stdio: "pipe" }),
    /Boolean flags take no value/,
  );
});

test("Buddy's remote config keeps its bindings and gains no way in from outside", () => {
  const errors: ParseError[] = [];
  const base = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), errors);
  assert.deepEqual(errors, []);
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    BUDDY_DATABASE_ID: "11111111-2222-4333-8444-555555555555",
    BUDDY_PHOTOS_BUCKET: "buddy-test-photos",
    BUDDY_WORKER_NAME: "buddy-test",
  };
  const config = buddyConfig(base, env);
  for (const key of Object.keys(env))
    assert.throws(() => buddyConfig(base, { ...env, [key]: "" }), new RegExp(key));
  assert.equal(config.env, undefined);
  for (const key of ["main", "vars", "durable_objects", "migrations", "compatibility_date"])
    assert.deepEqual(config[key], base[key]);
  // The whole point of the split: no hostname and nothing to serve. A route here
  // would put the worker holding the OpenAI key and the session state on the
  // public internet, which no test elsewhere would notice.
  assert.equal(config.routes, undefined);
  assert.equal(config.assets, undefined);
  assert.equal(base.assets, undefined, "Buddy serves no assets locally either");
  assert.equal(config.workers_dev, false);
  assert.equal(
    config.ai,
    undefined,
    "OpenAI-only production must not request a Workers AI binding",
  );
  assert.deepEqual(
    buddyConfig({ ...base, vars: { ...base.vars, BUDDY_MODEL: "@cf/test-model" } }, env).ai,
    base.ai,
  );
  assert.ok(base.ai, "Local model-comparison binding must remain untouched");
  assert.equal(base.d1_databases[0].database_id, undefined, "Local config must remain untouched");
});
