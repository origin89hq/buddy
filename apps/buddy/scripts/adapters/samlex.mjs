// Samlex America: one specification sheet per family, with one column per model
// (12/24/48 V variants) named on a "MODEL NO." line. Values are read by column
// band; a cell centred across the whole model area is a merged rating shared by
// every model on the sheet.
import { attr, document, nodes } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";
import { cells, columnGrid } from "./pdf-text.mjs";

export const extract = "lines";
const site = "https://samlexamerica.com";
const categories = [
  "dc-ac-power-inverters",
  "inverter-chargers",
  "solar-charge-controllers",
  "battery-chargers",
];
export async function discover(fetchText) {
  const sheets = new Map();
  for (const category of categories) {
    const listing = await fetchText(`${site}/product-category/${category}/`);
    const products = [
      ...new Set(
        nodes(document(listing), (n) => n.tagName === "a")
          .map((n) => attr(n, "href") ?? "")
          .filter((u) => /^https:\/\/samlexamerica\.com\/products\/[a-z0-9-]+\/$/.test(u)),
      ),
    ];
    for (const productUrl of products) {
      const page = await fetchText(productUrl);
      // "12xxx-" documents are specification sheets; "11xxx-" are manuals. Spanish sheets end in -ES.
      for (const url of new Set(
        nodes(document(page), (n) => n.tagName === "a")
          .map((n) => attr(n, "href") ?? "")
          .filter(
            (u) =>
              /\/wp-content\/uploads\/.*\/12\d{3}-[^/]*\.pdf$/.test(u) && !/-ES\.pdf$/i.test(u),
          ),
      )) {
        const entry = sheets.get(url) ?? { adapter: "samlex", family: category, url, products: [] };
        entry.products.push(productUrl);
        sheets.set(url, entry);
      }
    }
  }
  if (sheets.size < 20) throw new Error(`Unexpected Samlex sheet count: ${sheets.size}`);
  return [...sheets.values()];
}

const kinds = {
  "dc-ac-power-inverters": "inverter",
  "inverter-chargers": "inverter-charger",
  "solar-charge-controllers": "charge-controller",
  "battery-chargers": "battery-charger",
};
export function records(pages, entry, manifest, revision) {
  const page = pages[0];
  // The sheet fonts mangle case ("MODEl NO.", "PSe-12125A"); model numbers are upper case on every Samlex sheet.
  const headerLine = page.lines.find((l) => /^MODEL NO\.? /i.test(l.text));
  if (!headerLine) throw new Error("No MODEL NO. line");
  const modelWords = headerLine.words
    .slice(headerLine.words.findIndex((w) => /^NO\.?$/i.test(w.text)) + 1)
    .map((w) => ({ ...w, text: w.text.toUpperCase() }));
  if (!modelWords.length || !modelWords.every((w) => /^[A-Z]{2,4}-[A-Z0-9-]+$/.test(w.text)))
    throw new Error(`Model line is not model numbers: ${headerLine.text.slice(0, 80)}`);
  const grid = columnGrid(modelWords);
  const rows = page.lines.filter((l) => l.top > headerLine.top).map((l) => cells(l, grid));
  const get = (pattern, column, optional = false) => {
    const hits = rows.filter((r) => pattern.test(r.label));
    if (hits.length > 1) {
      if (optional) return undefined;
      throw new Error(
        `Duplicate row: ${hits
          .map((h) => h.label)
          .join(" / ")
          .slice(0, 100)}`,
      );
    }
    return hits[0]?.values[column];
  };
  // "3500 Watts", "1200W" and "1000 Watts (< 10 ms)" are all watts; the parenthetical is the surge duration.
  const watts = (raw) => {
    const m = String(raw)
      .replace(/\*/g, "")
      .match(/^(.+?)\s*(?:W|Watts)(?:\s*\((.+)\))?$/i);
    if (!m) throw new Error(`Invalid Watts quantity: ${raw}`);
    return { value: numeric(m[1], ""), note: m[2] };
  };
  // Four generations of sheet spell the same two rows four ways:
  // "CONTINUOUS OUTPUT POWER (At Power Factor = 1)", "MAX. CONTINUOUS ACTIVE POWER OUTPUT (POWER FACTOR = 1)",
  // "POWER, CONTINUOUS (At Power Factor = 1)" and "OUTPUT POWER, CONTINUOUS (RESISTIVE LOAD)".
  const continuousRow = (label) =>
    /CONTINUOUS/i.test(label) &&
    /POWER/i.test(label) &&
    !/SURGE|INPUT CURRENT|EFFICIENCY|SHUTDOWN|AT CONTINUOUS/i.test(label);
  const surgeRow = (label) =>
    /SURGE/i.test(label) && /POWER/i.test(label) && !/SHUTDOWN|CONTINUOUS/i.test(label);
  const result = [];
  for (const [column, word] of modelWords.entries()) {
    const model = word.text,
      specifications = [];
    const rawWatts = get({ test: continuousRow }, column);
    if (rawWatts) {
      const continuous = watts(rawWatts),
        surgeRaw = get({ test: surgeRow }, column),
        surge = surgeRaw && watts(surgeRaw);
      if (surge && surge.value < continuous.value)
        throw new Error(`Surge below continuous for ${model}`);
      specifications.push(
        spec(
          "Continuous AC output power",
          continuous.value,
          "W",
          "At power factor 1, as published. Derates with temperature per the sheet.",
        ),
      );
      if (surge)
        specifications.push(
          spec(
            "Surge AC output power",
            surge.value,
            "W",
            surge.note
              ? `Surge for ${surge.note}, as published. Not continuous output.`
              : "Surge only; duration is on the sheet, not in this figure.",
          ),
        );
    }
    const nominal = get(/^NOMINAL DC INPUT VOLTAGE$/, column);
    if (nominal)
      specifications.push(
        spec(
          "Nominal DC input voltage",
          numeric(nominal.replace(/\s*VDC$/i, " V"), "V"),
          "V",
          "Battery input variant of this model number; not the AC output voltage.",
        ),
      );
    for (const [pattern, name, conditions] of [
      [
        /^DC INPUT VOLTAGE RANGE$/,
        "DC input voltage range",
        "Operating input range as published; not a charging setting.",
      ],
      [/^MAXIMUM INPUT CURRENT$/, "Maximum DC input current", "At full load, as published."],
      [
        /^DC INPUT CURRENT AT NO LOAD$/,
        "No-load DC input current",
        "As published; the inequality is preserved.",
      ],
      [/^OUTPUT VOLTAGE$/, "AC output voltage", "As published with tolerance."],
      [/^PEAK EFFICIENCY$/, "Peak efficiency", "As published."],
      [/^OPERATING TEMPERATURE RANGE$/, "Operating temperature range", "As published."],
      [
        /^WEIGHT(, KG| KG)?/,
        "Weight (kg)",
        "As published, kilograms first where the sheet gives both.",
      ],
    ]) {
      const value = get(pattern, column, true);
      if (value) specifications.push(spec(name, value.slice(0, 100), null, conditions));
    }
    // Charger and accessory sheets share the layout but not the rows this adapter reads; a record
    // with only a weight and a temperature range would name a product without rating it.
    if (!specifications.some((s) => s.name === "Continuous AC output power"))
      throw new Error(
        `No AC output power rating for ${model}; charger and accessory rows are not parsed yet`,
      );
    result.push(
      makeRecord(
        "Samlex",
        model,
        kinds[entry.family] ?? "inverter",
        specifications,
        entry,
        manifest,
        revision,
        {
          source: { title: `Samlex ${model} specification sheet`, page: 1, section: undefined },
          limitations: [
            "Specification-sheet ratings. A wired remote or two-wire on/off input named on the sheet is not a verified Origin89 integration.",
          ],
        },
      ),
    );
  }
  return result;
}
