import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { knowledgeRecordSchema } from "../src/knowledge.ts";
import { activateCatalogueSql, recordSql } from "./import-knowledge.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
export const catalogueIds = [
  "sam-cec",
  "manufacturer-specifications",
  "cec-batteries",
  "reviewed-equipment",
];
const maxRecords = 2_000_000;

async function fileDigest(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function* records(path) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 16000) throw new Error("Oversized catalogue record");
      yield knowledgeRecordSchema.parse(JSON.parse(line));
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

// Export only validated facts and reports. Raw source PDFs, local SQL and private setup data stay out.
export async function createBundle(feeds, output, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full source Git commit is required");
  await mkdir(output, { recursive: false });
  const manifest = { version: 1, commit, catalogues: [] };
  for (const feed of feeds) {
    if (!catalogueIds.includes(feed.id) || manifest.catalogues.some((item) => item.id === feed.id))
      throw new Error("Invalid or duplicate catalogue");
    const destination = join(output, feed.id);
    await mkdir(destination);
    await copyFile(feed.records, join(destination, "records.jsonl"));
    await copyFile(feed.report, join(destination, "report.json"));
    const recordsSha256 = await fileDigest(join(destination, "records.jsonl"));
    let count = 0;
    for await (const _ of records(join(destination, "records.jsonl"))) count++;
    manifest.catalogues.push({
      id: feed.id,
      revision: recordsSha256,
      records: count,
      reportSha256: await fileDigest(join(destination, "report.json")),
    });
    if (feed.id === "sam-cec") {
      await copyFile(
        join(resolve(feed.records, ".."), "LICENSE-SAM.txt"),
        join(destination, "LICENSE-SAM.txt"),
      );
      manifest.catalogues.at(-1).licenseSha256 = await fileDigest(
        join(destination, "LICENSE-SAM.txt"),
      );
    }
  }
  await writeFile(join(output, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  return verifyBundle(output);
}

// Validate the entire release and compile SQL locally before the first database mutation.
// SQL from an artifact is never executed. Record IDs bind content to this catalogue revision.
export async function verifyBundle(directory, { expectedDigest, sqlDirectory } = {}) {
  const manifestPath = join(directory, "bundle.json");
  const digest = await fileDigest(manifestPath);
  if (expectedDigest && (!digestPattern.test(expectedDigest) || digest !== expectedDigest))
    throw new Error("Bundle digest mismatch");
  if ((await lstat(manifestPath)).size > 16000) throw new Error("Oversized bundle manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !Array.isArray(manifest.catalogues) ||
    !manifest.catalogues.length ||
    manifest.catalogues.length > catalogueIds.length
  )
    throw new Error("Invalid bundle manifest");
  const seen = new Set(),
    compiled = [];
  if (sqlDirectory) await mkdir(sqlDirectory, { recursive: true });
  for (const entry of manifest.catalogues) {
    if (
      !catalogueIds.includes(entry.id) ||
      seen.has(entry.id) ||
      !digestPattern.test(entry.revision) ||
      !digestPattern.test(entry.reportSha256) ||
      !Number.isSafeInteger(entry.records) ||
      entry.records < 1 ||
      entry.records > maxRecords
    )
      throw new Error("Invalid catalogue manifest");
    seen.add(entry.id);
    const folder = join(directory, entry.id);
    if (!(await lstat(folder)).isDirectory() || (await lstat(folder)).isSymbolicLink())
      throw new Error("Invalid catalogue directory");
    const data = join(folder, "records.jsonl");
    if (
      (await fileDigest(data)) !== entry.revision ||
      (await fileDigest(join(folder, "report.json"))) !== entry.reportSha256
    )
      throw new Error(`Catalogue checksum mismatch: ${entry.id}`);
    if (
      entry.id === "sam-cec" &&
      (!digestPattern.test(entry.licenseSha256) ||
        (await fileDigest(join(folder, "LICENSE-SAM.txt"))) !== entry.licenseSha256)
    )
      throw new Error("SAM licence missing or changed");
    const ids = new Set(),
      files = [];
    let count = 0,
      chunk = "";
    const flush = async () => {
      if (!sqlDirectory || !chunk) return;
      const file = join(sqlDirectory, `${entry.id}-${files.length}.sql`);
      await writeFile(file, chunk);
      files.push(file);
      chunk = "";
    };
    for await (const record of records(data)) {
      if (ids.has(record.id)) throw new Error(`Duplicate record ID in ${entry.id}`);
      ids.add(record.id);
      if (++count > entry.records) throw new Error(`Unexpected record count: ${entry.id}`);
      if (sqlDirectory) {
        const id = `pub-${sha(`${entry.id}:${entry.revision}:${record.id}`)}`;
        chunk += recordSql({ ...record, id }, entry);
        if (count % 250 === 0) await flush();
      }
    }
    await flush();
    if (count !== entry.records) throw new Error(`Unexpected record count: ${entry.id}`);
    compiled.push({ ...entry, files });
  }
  return { digest, manifest, compiled };
}

export async function publishBundle(directory, { expectedDigest, run, sqlDirectory }) {
  const release = await verifyBundle(directory, { expectedDigest, sqlDirectory });
  await run(["migrate"]);
  const pending = [];
  for (const entry of release.compiled) {
    const current = await run([
      "query",
      `SELECT active_revision FROM knowledge_catalogues WHERE id='${entry.id}'`,
    ]);
    // Do not momentarily stage records from an already active revision during a retry.
    if (current[0]?.active_revision === entry.revision) continue;
    pending.push(entry);
    for (const file of entry.files) await run(["file", file]);
    const count = await run([
      "query",
      `SELECT COUNT(*) AS records FROM knowledge_records WHERE catalogue_id='${entry.id}' AND catalogue_revision='${entry.revision}' AND status='verified'`,
    ]);
    if (count[0]?.records !== entry.records)
      throw new Error(`Staged record count mismatch: ${entry.id}`);
  }
  // All uploads finish before any catalogue changes. Each pointer switch is atomic.
  for (const entry of pending) {
    await run([
      "query",
      activateCatalogueSql(entry, entry.records, {
        ...entry,
        files: undefined,
        bundleDigest: release.digest,
        commit: release.manifest.commit,
      }),
    ]);
  }
  for (const entry of release.compiled) {
    const result = await run([
      "query",
      `SELECT c.active_revision, COUNT(r.id) AS records FROM knowledge_catalogues c JOIN knowledge_records r ON r.catalogue_id=c.id AND r.catalogue_revision=c.active_revision AND r.status='verified' WHERE c.id='${entry.id}' GROUP BY c.active_revision`,
    ]);
    if (result[0]?.active_revision !== entry.revision || result[0]?.records !== entry.records)
      throw new Error(`Activation verification failed: ${entry.id}`);
  }
  return { digest: release.digest, catalogues: release.manifest.catalogues };
}

export function wranglerRunner(
  config,
  remote,
  command = [process.execPath, join(app, "node_modules/wrangler/bin/wrangler.js")],
) {
  return async ([operation, value]) => {
    const args =
      operation === "migrate"
        ? ["d1", "migrations", "apply", "KNOWLEDGE"]
        : [
            "d1",
            "execute",
            "KNOWLEDGE",
            operation === "file" ? "--file" : "--command",
            value,
            "--json",
            "--yes",
          ];
    args.push(
      "--config",
      config,
      remote ? "--remote" : "--local",
      "--experimental-provision=false",
    );
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: app,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const code = await new Promise((done, fail) => {
      child.on("error", fail);
      child.on("close", done);
    });
    if (code !== 0)
      throw new Error(`D1 ${operation} failed (${code}): ${stderr || stdout.slice(-4000)}`);
    // Remote file imports emit spinner text even with --json. Wrangler exits
    // nonzero on import failure; publishBundle checks staged counts separately.
    // Only command queries return rows that the publisher needs to parse.
    if (operation !== "query") return [];
    const results = JSON.parse(stdout);
    if (
      !Array.isArray(results) ||
      results.some((result) => result.success === false || result.error)
    )
      throw new Error("D1 reported an unsuccessful query");
    return results[0]?.results ?? [];
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map();
  for (const arg of args) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!match || options.has(match[1])) throw new Error("Invalid or duplicate argument");
    options.set(match[1], match[2] ?? true);
  }
  const allowed = {
    build: ["output", "commit", "offline", "catalogue"],
    verify: ["bundle", "expect-sha256"],
    publish: ["bundle", "expect-sha256", "config", "local", "remote"],
  }[command];
  if (!allowed || [...options.keys()].some((key) => !allowed.includes(key)))
    throw new Error("Use build, verify or publish; see DEPLOYMENT.md for arguments");
  if (["offline", "local", "remote"].some((key) => options.has(key) && options.get(key) !== true))
    throw new Error("Boolean flags take no value; choose --local or --remote explicitly");
  const required = (key) => {
    const value = options.get(key);
    if (typeof value !== "string" || !value) throw new Error(`--${key}=... is required`);
    return value;
  };
  if (command === "build") {
    const selected = options.get("catalogue") ?? "all";
    if (selected !== "all" && !catalogueIds.includes(selected))
      throw new Error("Unknown catalogue");
    const chosen = selected === "all" ? catalogueIds : [selected],
      feeds = [];
    for (const id of chosen) {
      if (id === "reviewed-equipment") {
        const dir = await mkdtemp(join(tmpdir(), "buddy-reviewed-"));
        try {
          let count = 0;
          for await (const _ of records(join(app, "knowledge/reviewed.jsonl"))) count++;
          await writeFile(
            join(dir, "report.json"),
            JSON.stringify({
              acceptedRecords: count,
              rejected: [],
              conflicts: [],
              inferenceCalls: 0,
              source: "knowledge/reviewed.jsonl",
            }),
          );
          // The reviewed source and report are copied before this temporary directory is removed below.
          feeds.push({
            id,
            records: join(app, "knowledge/reviewed.jsonl"),
            report: join(dir, "report.json"),
            temporary: dir,
          });
        } catch (error) {
          await rm(dir, { recursive: true, force: true });
          throw error;
        }
      } else {
        const { buildSam } = await import("./sam-catalogue.mjs");
        const { buildManufacturers } = await import("./manufacturer-catalogue.mjs");
        const { buildCecBatteries } = await import("./cec-batteries.mjs");
        const built = await {
          "sam-cec": buildSam,
          "manufacturer-specifications": buildManufacturers,
          "cec-batteries": buildCecBatteries,
        }[id]({ offline: options.has("offline") });
        feeds.push({
          id,
          records: join(built.directory, "records.jsonl"),
          report: join(built.directory, "report.json"),
        });
      }
    }
    try {
      const release = await createBundle(feeds, resolve(required("output")), required("commit"));
      console.log(JSON.stringify({ digest: release.digest, ...release.manifest }, null, 2));
    } finally {
      for (const feed of feeds)
        if (feed.temporary) await rm(feed.temporary, { recursive: true, force: true });
    }
  } else if (command === "verify") {
    const release = await verifyBundle(resolve(required("bundle")), {
      expectedDigest: options.get("expect-sha256"),
    });
    console.log(JSON.stringify({ digest: release.digest, ...release.manifest }, null, 2));
  } else {
    if (options.has("local") === options.has("remote"))
      throw new Error("Choose exactly one of --local or --remote");
    const expectedDigest = required("expect-sha256"),
      config = resolve(required("config"));
    if (options.has("remote")) {
      // Production uses the generated JSON config with an explicit account and database UUID.
      const target = JSON.parse(await readFile(config, "utf8"));
      const db = target.d1_databases?.filter((item) => item.binding === "KNOWLEDGE");
      if (
        !/^[a-f0-9]{32}$/.test(target.account_id) ||
        target.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID ||
        db?.length !== 1 ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(db[0].database_id)
      )
        throw new Error("Remote publication requires an explicit matching account and database ID");
    }
    const temporary = await mkdtemp(join(tmpdir(), "buddy-release-sql-"));
    try {
      console.log(
        JSON.stringify(
          await publishBundle(resolve(required("bundle")), {
            expectedDigest,
            sqlDirectory: temporary,
            run: wranglerRunner(config, options.has("remote")),
          }),
          null,
          2,
        ),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
