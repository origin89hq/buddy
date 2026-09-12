// Pin the manufacturer document indexes that a REST API exposes (EG4's media
// library, Xantrex's docs post type) and write a plain index of PDF documents
// per maker. An index is where a datasheet is, not what it says: no record is
// published from it, and no AI call is made.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../knowledge/", import.meta.url));
const cache = join(root, "sources/document-indexes"),
  output = join(root, "generated/document-indexes");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 Origin89-catalogue-snapshot";

export const makers = {
  eg4: {
    site: "https://eg4electronics.com",
    // The documentation posts carry no file; the PDFs are media attachments.
    page: (n) =>
      `https://eg4electronics.com/wp-json/wp/v2/media?media_type=application&per_page=100&page=${n}&_fields=id,title,source_url,mime_type,date,modified`,
    documents: (items) =>
      items
        .filter((m) => m.mime_type === "application/pdf")
        .map((m) => ({
          id: m.id,
          title: decode(m.title.rendered),
          url: m.source_url,
          modified: m.modified,
        })),
  },
  xantrex: {
    site: "https://xantrex.com",
    page: (n) =>
      `https://xantrex.com/wp-json/wp/v2/docs?per_page=100&page=${n}&_fields=id,title,link,content,parent,modified`,
    documents: (items) =>
      items.flatMap((d) =>
        [
          ...new Set(
            [...String(d.content?.rendered ?? "").matchAll(/href="([^"]+\.pdf)"/g)].map(
              (m) => m[1],
            ),
          ),
        ].map((url) => ({
          id: d.id,
          title: decode(d.title.rendered),
          url,
          page: d.link,
          product: d.link.match(/\/library\/[^/]+\/([^/]+)\//)?.[1] ?? null,
          modified: d.modified,
        })),
      ),
  },
};
const decode = (text) =>
  text
    .replace(/&#8211;/g, "–")
    .replace(/&#038;|&amp;/g, "&")
    .replace(/&#8217;/g, "’")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "")
    .trim();

async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(40_000),
    headers: { "user-agent": userAgent, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    total: Number(response.headers.get("x-wp-total") ?? 0),
    totalPages: Number(response.headers.get("x-wp-totalpages") ?? 0),
  };
}

export async function snapshotIndexes({ offline = false } = {}) {
  await mkdir(cache, { recursive: true });
  await mkdir(output, { recursive: true });
  const manifestPath = join(root, "document-index-sources.json");
  const previous = await readFile(manifestPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const manifest = {
    id: "document-indexes",
    checkedAt: offline ? previous?.checkedAt : new Date().toISOString().slice(0, 10),
    makers: {},
  };
  const summary = {};
  for (const [name, maker] of Object.entries(makers)) {
    const pages = [];
    if (offline) {
      if (!previous?.makers[name]) throw new Error(`No pinned pages for ${name}`);
      for (const page of previous.makers[name].pages) {
        const bytes = await readFile(join(cache, page.file));
        if (sha(bytes) !== page.sha256) throw new Error(`Pinned index page changed: ${page.url}`);
        pages.push({ ...page, items: JSON.parse(bytes.toString("utf8")) });
      }
    } else {
      for (let n = 1; n <= 20; n++) {
        const url = maker.page(n),
          { bytes, total, totalPages } = await download(url);
        const file = `${sha(bytes)}.json`;
        await writeFile(join(cache, file), bytes);
        pages.push({
          url,
          file,
          sha256: sha(bytes),
          bytes: bytes.length,
          total,
          items: JSON.parse(bytes.toString("utf8")),
        });
        if (n >= totalPages) break;
      }
    }
    const documents = maker.documents(pages.flatMap((p) => p.items));
    if (documents.length < 50)
      throw new Error(`Unexpectedly small ${name} index: ${documents.length}`);
    manifest.makers[name] = {
      site: maker.site,
      pages: pages.map(({ items, ...page }) => page),
      documents: documents.length,
    };
    const index = {
      maker: name,
      checkedAt: manifest.checkedAt,
      site: maker.site,
      note: "Document locations pinned from the maker's public REST API. Not specifications; a listed PDF has not been read.",
      documents: documents.sort((a, b) => a.url.localeCompare(b.url)),
    };
    await writeFile(join(output, `${name}.json`), JSON.stringify(index, null, 2) + "\n");
    summary[name] = documents.length;
  }
  if (!offline) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((a) => a !== "--offline"))
    throw new Error("Use --offline or no arguments");
  console.log(
    JSON.stringify(await snapshotIndexes({ offline: process.argv.includes("--offline") })),
  );
}
