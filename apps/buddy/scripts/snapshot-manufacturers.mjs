// Explicit acquisition command. Ordinary builds use the pinned manifest, never silently refresh it.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "./adapters/index.mjs";
import { sourceFilePattern } from "./manufacturer-catalogue.mjs";

const root = fileURLToPath(new URL("../knowledge/", import.meta.url));
const cache = join(root, "sources/manufacturers");
const args = process.argv.slice(2);
const flags = ["--refresh", "--fetch-pinned"],
  only = args
    .find((a) => a.startsWith("--only="))
    ?.slice(7)
    .split(",");
if (
  args.some((arg) => !flags.includes(arg) && !arg.startsWith("--only=")) ||
  args.filter((a) => flags.includes(a)).length > 1
)
  throw new Error("Use --refresh, --fetch-pinned or --only=<adapter,...>");
if (only?.some((name) => !adapters[name])) throw new Error(`Unknown adapter in --only: ${only}`);
await mkdir(cache, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 Origin89-catalogue-snapshot";
async function download(url, attempt = 1) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(40_000),
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xml,application/json,application/pdf,*/*",
    },
  });
  // A 429 is the site asking for a pause, so pause once; anything else is the site's answer.
  if (response.status === 429 && attempt === 1) {
    await new Promise((r) => setTimeout(r, 20_000));
    return download(url, 2);
  }
  if (!response.ok || !response.body) throw new Error(`${response.status}: ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 15 * 1024 * 1024) throw new Error(`Source too large: ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const repoFile = (path) =>
  readFile(fileURLToPath(new URL(`../../${path}`, new URL("../", import.meta.url))));
if (args.includes("--fetch-pinned")) {
  const manifest = JSON.parse(await readFile(join(root, "manufacturer-sources.json"), "utf8"));
  for (const entry of [...manifest.discovery, ...manifest.entries]) {
    if (!sourceFilePattern.test(entry.file)) throw new Error("Invalid pinned filename");
    let raw;
    try {
      raw = await readFile(join(cache, entry.file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      raw = entry.localPath ? await repoFile(entry.localPath) : await download(entry.url);
    }
    if (sha(raw) !== entry.sha256 || raw.length !== entry.bytes)
      throw new Error(
        `Pinned bytes unavailable: ${entry.url}. Restore the original snapshot or explicitly review a new one.`,
      );
    await writeFile(join(cache, entry.file), raw);
  }
  console.log("Pinned manufacturer sources restored and checked; manifest unchanged.");
  process.exit(0);
}
const extensionOf = (bytes, format) =>
  format === "json" ? "json" : bytes.subarray(0, 4).toString() === "%PDF" ? "pdf" : "html";
async function fetchSource(url, format) {
  const cachePath = join(cache, `${sha(url)}.raw`);
  let bytes;
  try {
    bytes = args.includes("--refresh") ? await download(url) : await readFile(cachePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = await download(url);
  }
  await writeFile(cachePath, bytes);
  const filename = `${sha(bytes)}.${extensionOf(bytes, format)}`;
  await writeFile(join(cache, filename), bytes);
  return { url, file: filename, sha256: sha(bytes), bytes: bytes.length };
}
// Discovery pages are pinned too, so a listing that shrinks is a diff and not a silent loss.
const discovery = [],
  entries = [],
  errors = [];
const fetchText = (adapter) => async (url) => {
  const source = await fetchSource(url, /\.json(\?|$)/.test(url) ? "json" : "html");
  discovery.push({ adapter, ...source });
  return (await readFile(join(cache, source.file))).toString("utf8");
};
const fetchJson = (adapter) => async (url) => JSON.parse(await fetchText(adapter)(url));
async function snapshotAll(list) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < list.length) {
        const item = list[cursor++];
        try {
          if (item.localPath) {
            if (!/^docs\/vendor\/[a-z0-9.-]+\.pdf$/.test(item.localPath))
              throw new Error("Invalid repository source path");
            const bytes = await repoFile(item.localPath),
              file = `${sha(bytes)}.pdf`;
            await writeFile(join(cache, file), bytes);
            entries.push({ ...item, file, bytes: bytes.length, sha256: sha(bytes) });
          } else entries.push({ ...item, ...(await fetchSource(item.url, item.format)) });
        } catch (error) {
          errors.push({ ...item, reason: error.message });
        }
        if ((entries.length + errors.length) % 25 === 0)
          console.log(
            JSON.stringify({
              event: "snapshot_progress",
              downloaded: entries.length,
              errors: errors.length,
              total: list.length,
            }),
          );
      }
    }),
  );
}
const previous = only
  ? JSON.parse(await readFile(join(root, "manufacturer-sources.json"), "utf8"))
  : null;
for (const [name, adapter] of Object.entries(adapters)) {
  if (!adapter.discover || (only && !only.includes(name))) continue;
  try {
    await snapshotAll(
      await adapter.discover(name === "duromax" ? fetchJson(name) : fetchText(name)),
    );
  } catch (error) {
    errors.push({ adapter: name, reason: `Discovery failed: ${error.message}` });
  }
}
const feeds = JSON.parse(await readFile(join(root, "manufacturer-feeds.json"), "utf8"));
await snapshotAll(feeds.filter((feed) => !only || only.includes(feed.adapter)));
if (previous) {
  // --only re-snapshots the named adapters and keeps every other pinned entry as it was.
  const keep = (list) => list.filter((e) => !only.includes(e.adapter));
  discovery.push(...keep(previous.discovery));
  entries.push(...keep(previous.entries));
  errors.push(...keep(previous.errors ?? []));
}
entries.sort((a, b) => a.url.localeCompare(b.url));
discovery.sort((a, b) => a.url.localeCompare(b.url));
const manifest = {
  id: "manufacturer-specifications",
  checkedAt: new Date().toISOString().slice(0, 10),
  discovery,
  entries,
  errors,
};
await writeFile(join(root, "manufacturer-sources.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  JSON.stringify({
    event: "snapshot_complete",
    entries: entries.length,
    byAdapter: entries.reduce((counts, entry) => {
      counts[entry.adapter] = (counts[entry.adapter] ?? 0) + 1;
      return counts;
    }, {}),
    errors,
  }),
);
