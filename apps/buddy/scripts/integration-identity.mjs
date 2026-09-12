// Pin the third-party pages that say which batteries and inverters talk, and
// over what: Victron's battery-compatibility wiki index, Victron's GX Modbus-TCP
// register list, SolarAssistant's device help index and the dbus-serialbattery
// BMS list. The parsed output is identity only, brand names and page URLs, so a
// future integration profile can cite a pinned page instead of a memory.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attr, document, nodes, text } from "./catalogue-html.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../knowledge/", import.meta.url)),
  appRoot = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, "sources/integration-identity");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 Origin89-catalogue-snapshot";

export const sources = {
  "victron-battery-compatibility": {
    url: "https://www.victronenergy.com/live/battery_compatibility:start",
    parse: (html) => {
      const links = nodes(
        document(html),
        (n) =>
          n.tagName === "a" &&
          /^\/live\/battery_compatibility:[a-z0-9_-]+$/.test(attr(n, "href") ?? ""),
      );
      const pages = [
        ...new Map(
          links.map((a) => [
            attr(a, "href"),
            {
              slug: attr(a, "href").split(":")[1],
              title: text(a),
              url: `https://www.victronenergy.com${attr(a, "href")}`,
            },
          ]),
        ).values(),
      ].filter((p) => p.slug !== "start");
      if (pages.length < 15)
        throw new Error(`Unexpectedly short compatibility index: ${pages.length}`);
      return {
        kind: "battery-bms-compatibility",
        note: "Battery brands with a Victron-tested BMS page. A page here means Victron documented a CAN-bus BMS pairing; it says nothing about an Origin89 driver.",
        pages: pages.sort((a, b) => a.slug.localeCompare(b.slug)),
      };
    },
  },
  "victron-modbus-registers": {
    url: "https://github.com/victronenergy/dbus_modbustcp/raw/master/CCGX-Modbus-TCP-register-list.xlsx",
    binary: true,
    parse: async (_bytes, file) => {
      const result = await run(
        process.env.BUDDY_PYTHON ?? "python3",
        [join(appRoot, "scripts/read-xlsx-rows.py"), file],
        { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
      );
      const rows = JSON.parse(result.stdout);
      const header = rows.findIndex((r) => r[0] === "dbus-service-name");
      if (header < 0) throw new Error("Register list header not found");
      const registers = rows
        .slice(header + 1)
        .filter((r) => r[0] && r[2] !== null)
        .map((r) => ({
          service: r[0],
          description: r[1],
          address: r[2],
          type: r[3],
          scale: r[4],
          range: r[5],
          path: r[6],
          writable: r[7],
          unit: r[8],
        }));
      const services = [...new Set(registers.map((r) => r.service))].sort();
      if (registers.length < 500)
        throw new Error(`Unexpectedly short register list: ${registers.length}`);
      return {
        kind: "modbus-tcp-register-list",
        note: "Victron GX Modbus-TCP registers per D-Bus service, as published in Victron's repository. Two versions circulate; this is the GitHub copy at the pinned hash.",
        services,
        registers: registers.length,
        sample: registers.slice(0, 5),
      };
    },
  },
  "solar-assistant-devices": {
    url: "https://solar-assistant.io/help/",
    parse: (html) => {
      const links = nodes(
        document(html),
        (n) =>
          n.tagName === "a" &&
          /^\/help\/(inverters|battery)\/[a-z0-9-]+$/.test(attr(n, "href") ?? ""),
      );
      const pages = [
        ...new Map(
          links.map((a) => [
            attr(a, "href"),
            {
              kind: attr(a, "href").split("/")[2],
              slug: attr(a, "href").split("/")[3],
              title: text(a),
              url: `https://solar-assistant.io${attr(a, "href")}`,
            },
          ]),
        ).values(),
      ];
      if (pages.length < 20)
        throw new Error(`Unexpectedly short SolarAssistant index: ${pages.length}`);
      return {
        kind: "third-party-integration-index",
        note: "Inverter and battery families SolarAssistant documents. A tested-device page is evidence of which protocol a family speaks and a lead to the original manual; cite the manual.",
        pages: pages.sort((a, b) => a.url.localeCompare(b.url)),
      };
    },
  },
  "dbus-serialbattery-bms": {
    url: "https://mr-manuel.github.io/venus-os_dbus-serialbattery_docs/general/supported-bms",
    parse: (html) => {
      // Headings are "• Daly BMS 🥉 Third most used BMS" with zero-width spaces; keep the name.
      const headings = nodes(document(html), (n) => /^h[2-4]$/.test(n.tagName ?? ""))
        .map(text)
        .map((t) =>
          t
            .replace(/[\u200b•]/g, "")
            .replace(/^\|-\s*/, "")
            .replace(/\s*🥇.*|\s*🥈.*|\s*🥉.*/g, "")
            .trim(),
        )
        .filter(
          (t) =>
            t &&
            !/^(Supported BMS|Disabled|Notes|Add|Which|Contributors|Most used BMS|Currently supported|Other BMS)/i.test(
              t,
            ),
        );
      if (headings.length < 15) throw new Error(`Unexpectedly short BMS list: ${headings.length}`);
      return {
        kind: "bms-driver-list",
        note: "BMS families the dbus-serialbattery driver reads over serial, CAN or Bluetooth. A driver existing elsewhere is not an Origin89 driver.",
        bms: headings,
      };
    },
  },
};

async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(40_000),
    headers: { "user-agent": userAgent },
  });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
export async function snapshotIdentity({ offline = false } = {}) {
  await mkdir(cache, { recursive: true });
  const manifestPath = join(root, "integration-identity-sources.json"),
    outputPath = join(root, "generated/integration-identity.json");
  await mkdir(join(root, "generated"), { recursive: true });
  const previous = await readFile(manifestPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const manifest = {
    id: "integration-identity",
    checkedAt: offline ? previous?.checkedAt : new Date().toISOString().slice(0, 10),
    sources: {},
  };
  const parsed = {};
  for (const [name, source] of Object.entries(sources)) {
    let bytes,
      pinned = previous?.sources[name];
    if (offline) {
      if (!pinned) throw new Error(`No pinned source for ${name}`);
      bytes = await readFile(join(cache, pinned.file));
      if (sha(bytes) !== pinned.sha256) throw new Error(`Pinned source changed: ${source.url}`);
    } else {
      bytes = await download(source.url);
      pinned = {
        url: source.url,
        file: `${sha(bytes)}.${source.binary ? "xlsx" : "html"}`,
        sha256: sha(bytes),
        bytes: bytes.length,
      };
      await writeFile(join(cache, pinned.file), bytes);
    }
    parsed[name] = {
      source: pinned,
      ...(await source.parse(
        source.binary ? bytes : bytes.toString("utf8"),
        join(cache, pinned.file),
      )),
    };
    manifest.sources[name] = pinned;
  }
  if (!offline) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        id: "integration-identity",
        checkedAt: manifest.checkedAt,
        note: "Identity of who talks to what, pinned by hash. Not specifications and not verified Origin89 integrations; integration-profiles.json carries evidence per record.",
        ...parsed,
      },
      null,
      2,
    ) + "\n",
  );
  return Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, v.pages?.length ?? v.registers ?? v.bms?.length]),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((a) => a !== "--offline"))
    throw new Error("Use --offline or no arguments");
  console.log(
    JSON.stringify(await snapshotIdentity({ offline: process.argv.includes("--offline") })),
  );
}
