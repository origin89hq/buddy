// U.S. Battery: one WordPress page per model. Every page carries the same
// comparison table of the model's BCI-group siblings, so the column is chosen by
// the page's own heading and never by position. The page does not state the
// voltage; it comes from the voltage-class listing that linked the page.

import { identityKey } from "../../src/knowledge.ts";
import { attr, document, nodes, tables, text } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";

const site = "https://www.usbattery.com";
const listings = [2, 6, 8, 12, 24, 48].map((volts) => ({
  volts,
  url: `${site}/${volts}-volt-batteries/`,
}));

export async function discover(fetchHtml) {
  const found = new Map();
  for (const listing of listings) {
    const links = nodes(document(await fetchHtml(listing.url)), (n) => n.tagName === "a").map(
      (n) => attr(n, "href") ?? "",
    );
    for (const url of new Set(
      links.filter(
        (u) => /^https:\/\/www\.usbattery\.com\/us-[a-z0-9-]+\/$/.test(u) && !/user-manual/.test(u),
      ),
    )) {
      const entry = found.get(url) ?? {
        adapter: "us-battery",
        family: "deep-cycle battery",
        url,
        voltageClasses: [],
      };
      entry.voltageClasses.push(listing.volts);
      found.set(url, entry);
    }
  }
  if (found.size < 40 || found.size > 200)
    throw new Error(`Unexpected U.S. Battery listing size: ${found.size}`);
  return [...found.values()];
}

export function records(html, entry, manifest, revision) {
  const heading = nodes(document(html), (n) => n.tagName === "h1")
    .map(text)
    .find(Boolean);
  if (!heading || !/^US /.test(heading)) throw new Error(`No model heading: ${heading}`);
  if (entry.voltageClasses?.length !== 1)
    throw new Error(
      `Listed under ${entry.voltageClasses?.length ?? 0} voltage classes; refusing to guess`,
    );
  // Table headers carry zero-width spaces and drop a space ("US REGC2H XC2"); identity ignores both.
  const same = (a, b) => identityKey("", a.replace(/\u200b/g, "")) === identityKey("", b);
  const table = tables(html).find(
    (t) => t[0]?.some((h) => same(h, heading)) && t.some((r) => r[0] === "20 Hour Rate"),
  );
  if (!table) throw new Error("Model absent from the comparison table on its own page");
  const columns = table[0].map((h, i) => (same(h, heading) ? i : -1)).filter((i) => i >= 0);
  if (columns.length !== 1) throw new Error("Model appears twice in the comparison table");
  const [column] = columns;
  const get = (label) => {
    const rows = table.filter((r) => r[0] === label);
    if (rows.length > 1) throw new Error(`Duplicate row: ${label}`);
    return rows[0]?.[column];
  };
  const chemistryRaw = get("Chemistry");
  const chemistry =
    chemistryRaw === "Flooded Lead-Acid"
      ? "Flooded lead-acid"
      : chemistryRaw === "AGM"
        ? "AGM lead-acid"
        : null;
  if (!chemistry) throw new Error(`Unrecognized chemistry: ${chemistryRaw}`);
  const volts = entry.voltageClasses[0],
    c20 = numeric(get("20 Hour Rate"));
  const specifications = [
    spec("Chemistry", chemistry, null, "Manufacturer product classification."),
    spec(
      "Voltage class",
      volts,
      "V",
      "Voltage class of the manufacturer listing that names this model; not the installed bank voltage.",
    ),
    spec(
      "Nominal voltage",
      volts,
      "V",
      "Nominal voltage of one battery; not the installed bank voltage.",
    ),
    spec(
      "Capacity C20",
      c20,
      "Ah",
      "20-hour rate as published on the comparison table. Test current and cutoff voltage are not stated on this page.",
    ),
  ];
  const reserves = table
    .filter((r) => /^Min\. @\d+ Amps$/.test(r[0]))
    .map((r) => ({ amps: Number(r[0].match(/\d+/)[0]), minutes: numeric(r[column]) }));
  let previous;
  for (const reserve of reserves.sort((a, b) => b.amps - a.amps)) {
    const delivered = (reserve.amps * reserve.minutes) / 60;
    // A discharge at a higher current delivers fewer Ah than C20 (Peukert), never more; a
    // swapped or mistyped cell fails this before it can become a published figure.
    if (
      delivered < c20 * 0.45 ||
      delivered > c20 * 1.05 ||
      (previous && reserve.minutes <= previous.minutes)
    )
      throw new Error(`Inconsistent reserve minutes at ${reserve.amps} A`);
    specifications.push(
      spec(
        `Discharge time at ${reserve.amps} A`,
        reserve.minutes,
        "min",
        `Minutes of discharge at a constant ${reserve.amps} A, as published. Cutoff voltage and temperature are not stated on this page.`,
      ),
    );
    previous = reserve;
  }
  for (const [label, name] of [
    ["BCI Group Size", "BCI group size"],
    ["Standard Terminal", "Standard terminal"],
    ["Dimensions", "Dimensions"],
  ]) {
    const value = get(label);
    if (value)
      specifications.push(
        spec(name, value.slice(0, 100), null, "As published on the comparison table."),
      );
  }
  const dataSheet = nodes(document(html), (n) => n.tagName === "a")
    .map((n) => attr(n, "href") ?? "")
    .find((u) => /usbattery\.com\/wp-content\/uploads\/.*data_sheet.*\.pdf$/i.test(u));
  return [
    makeRecord("U.S. Battery", heading, "battery", specifications, entry, manifest, revision, {
      source: { section: "Product comparison table" },
      limitations: dataSheet
        ? [
            `Multi-rate capacity table is in the manufacturer data sheet, not on this page: ${dataSheet}`.slice(
              0,
              200,
            ),
          ]
        : [],
    }),
  ];
}
