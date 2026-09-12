import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";

const knowledge = fileURLToPath(new URL("../knowledge/", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function sourcePlan(root = knowledge) {
  const names = ["sam-sources.json", "manufacturer-sources.json", "cec-batteries-source.json"];
  const manifests = await Promise.all(names.map((name) => readFile(join(root, name))));
  const [sam, manufacturers, cec] = manifests.map((bytes) => JSON.parse(bytes));
  const files = [
    ...sam.files.map((file) => ({
      path: `sam/${file.name}`,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
    { path: "sam/LICENSE", sha256: sam.license.sha256 },
    ...[...manufacturers.discovery, ...manufacturers.entries].map((file) => ({
      path: `manufacturers/${file.file}`,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
    { path: `cec-batteries/${cec.sha256}.xlsx`, sha256: cec.sha256, bytes: cec.bytes },
  ];
  const unique = new Map();
  for (const file of files) {
    if (
      !/^(sam|manufacturers|cec-batteries)\/[a-zA-Z0-9_. -]+$/.test(file.path) ||
      file.path.includes("..") ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid source pin");
    const existing = unique.get(file.path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(file))
      throw new Error("Conflicting source pins");
    unique.set(file.path, file);
  }
  return { key: `sources/${sha(Buffer.concat(manifests))}.jsonl.gz`, files: [...unique.values()] };
}
function checkSource(bytes, file) {
  if (
    bytes.length > 15 * 1024 * 1024 ||
    (file.bytes !== undefined && bytes.length !== file.bytes) ||
    sha(bytes) !== file.sha256
  )
    throw new Error(`Source checksum mismatch: ${file.path}`);
}

export async function packSources(plan, sourceRoot, output) {
  const temporary = `${output}.${process.pid}.tmp`;
  async function* entries() {
    for (const file of plan.files) {
      const bytes = await readFile(join(sourceRoot, file.path));
      checkSource(bytes, file);
      yield JSON.stringify({ path: file.path, data: bytes.toString("base64") }) + "\n";
    }
  }
  try {
    await pipeline(
      Readable.from(entries()),
      createGzip(),
      createWriteStream(temporary, { flags: "wx" }),
    );
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { key: plan.key, files: plan.files.length, output };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function recoverCache(destination, backup) {
  if (!(await exists(backup))) return;
  if (await exists(destination)) await rm(backup, { recursive: true });
  else await rename(backup, destination);
}

export async function restoreSources(plan, archive, destination) {
  destination = resolve(destination);
  const backup = `${destination}.restore-backup`;
  await mkdir(dirname(destination), { recursive: true });
  // A killed restore leaves either the previous complete cache in backup, or
  // the newly installed complete cache plus a backup awaiting cleanup.
  await recoverCache(destination, backup);
  const temporary = await mkdtemp(join(dirname(destination), "sources-restore-"));
  const expected = new Map(plan.files.map((file) => [file.path, file]));
  try {
    await pipeline(createReadStream(archive), createGunzip(), async (source) => {
      const save = async (line) => {
        if (line.length > 21 * 1024 * 1024) throw new Error("Oversized source archive entry");
        const entry = JSON.parse(line),
          file = expected.get(entry.path);
        if (!file || typeof entry.data !== "string")
          throw new Error("Unexpected or duplicate source archive entry");
        const bytes = Buffer.from(entry.data, "base64");
        checkSource(bytes, file);
        const path = join(temporary, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        expected.delete(file.path);
      };
      // Archive paths and base64 are ASCII. Bound a line while it is being read,
      // and let pipeline own stream errors instead of layering readline emitters.
      let pending = "";
      for await (const chunk of source) {
        pending += chunk.toString("utf8");
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          await save(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
        if (pending.length > 21 * 1024 * 1024) throw new Error("Oversized source archive entry");
      }
      if (pending) await save(pending);
    });
    if (expected.size) throw new Error("Incomplete source archive");
    if (await exists(destination)) await rename(destination, backup);
    try {
      // Both directories are siblings on the same filesystem. The cache is
      // installed in one rename, never as a mixture of old and new files.
      await rename(temporary, destination);
    } catch (error) {
      await recoverCache(destination, backup);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return { key: plan.key, files: plan.files.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path, ...extra] = process.argv.slice(2),
    plan = await sourcePlan();
  if (command === "key" && !path) console.log(plan.key);
  else if (["pack", "restore"].includes(command) && path && !extra.length) {
    const result =
      command === "pack"
        ? await packSources(plan, join(knowledge, "sources"), resolve(path))
        : await restoreSources(plan, resolve(path), join(knowledge, "sources"));
    console.log(JSON.stringify(result));
  } else
    throw new Error(
      "Usage: node scripts/catalogue-source-cache.mjs key | pack <archive.jsonl.gz> | restore <archive.jsonl.gz>",
    );
}
