// Discover Battery (Canada): one page per model, with the same label/value
// tables repeated across product tabs. Every repeated value must agree; a page
// whose tabs disagree is refused. The model listing behind the family pages is a
// browser-side search, so discovery is the handful of statically linked models
// plus the reviewed model URLs in manufacturer-feeds.json.
import { attr, document, nodes, tables, text } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";

const site = "https://discoverbattery.com";
const families = [
  "lithium-batteries/dlp-e",
  "lithium-batteries/lithium-blue",
  "lithium-batteries/lithium-mobile",
  "lithium-batteries/lithium-professional",
  "lithium-batteries/ultra-gen",
  "gel-cell/industrial-gel-batteries",
  "sla-vrla-batteries/lead-acid-deep-cycle-batteries",
  "sla-vrla-batteries/mobile-deep-cycle-batteries",
  "sla-vrla-batteries/industrial-agm-dry-cell-batteries",
];
export async function discover(fetchHtml) {
  const urls = new Set();
  for (const family of families) {
    for (const a of nodes(
      document(await fetchHtml(`${site}/products/${family}`)),
      (n) => n.tagName === "a",
    )) {
      const href = attr(a, "href") ?? "";
      if (/^\/products\/search\/[a-z0-9-]+$/.test(href)) urls.add(`${site}${href}`);
    }
  }
  return [...urls].sort().map((url) => ({ adapter: "discover", family: "battery", url }));
}

export function records(html, entry, manifest, revision) {
  const root = document(html);
  const title = nodes(root, (n) => n.tagName === "title").map(text)[0] ?? "";
  if (/Batteries \| Discover Battery$/.test(title))
    throw new Error(`Model URL resolves to a category page, not a product: ${title}`);
  const match = title.match(
    /^([A-Z0-9-]+) (.+?) (LiFePO4|AGM|Gel|Flooded) (.+?) \| Discover(?: Battery)?$/,
  );
  if (!match)
    throw new Error(
      /^[A-Z0-9-]+$/.test(title)
        ? `Title names no chemistry or product line: ${title}`
        : `Unrecognized product title: ${title}`,
    );
  const [, model, line, chemistryRaw, description] = match;
  const chemistry = {
    LiFePO4: "LiFePO4",
    AGM: "AGM lead-acid",
    Gel: "Gel lead-acid",
    Flooded: "Flooded lead-acid",
  }[chemistryRaw];
  const rows = tables(html).flat();
  // Tabs repeat a label; take the value only when every occurrence agrees.
  const get = (label) => {
    // A tab header repeats the label in the first value cell; the value is the first cell that is neither.
    const values = [
      ...new Set(
        rows
          .filter((r) => r[0] === label)
          .map((r) => r.slice(1).find((c) => c && c !== label))
          .filter(Boolean),
      ),
    ];
    if (values.length > 1) throw new Error(`Tabs disagree on ${label}: ${values.join(" / ")}`);
    return values[0];
  };
  const specifications = [
    spec("Chemistry", chemistry, null, "Manufacturer product classification."),
    spec(
      "Product line",
      `${line} ${description}`.slice(0, 100),
      null,
      "Manufacturer product line from the page title.",
    ),
  ];
  const number = (label, name, unit, conditions, parse = unit) => {
    const raw = get(label);
    if (raw !== undefined)
      specifications.push(spec(name, numeric(raw, parse === unit ? "" : parse), unit, conditions));
    return raw === undefined ? undefined : specifications.at(-1).value;
  };
  const ocv = number(
    "Open Circuit Voltage (V)",
    "Open-circuit voltage",
    "V",
    "Open-circuit voltage as published; nominal voltage is not stated separately on this page.",
  );
  const energy = number(
    "Nominal Energy (kWh)",
    "Nominal energy",
    "kWh",
    "Published nominal energy of one battery, not usable energy or present state of charge.",
  );
  const c1 = number(
    "Rated Ah Capacity (1C)",
    "Capacity C1",
    "Ah",
    "Rated capacity at the 1-hour (1C) rate, as published. Lead-acid-style C20 figures are not on this page.",
  );
  if (ocv && energy && c1 && Math.abs(energy * 1000 - ocv * c1) > ocv * c1 * 0.15)
    throw new Error("Nominal energy disagrees with open-circuit voltage × capacity");
  const dod = get("Usable DoD");
  if (dod)
    specifications.push(
      spec(
        "Usable depth of discharge",
        dod,
        null,
        "Manufacturer usable DoD; the usable Wh figure on the page is nominal energy times this.",
      ),
    );
  number(
    "Charge Voltage (Vdc)",
    "Charge voltage",
    "V",
    "Published bulk charge voltage; follow the manufacturer charging instructions.",
  );
  number(
    "Max Voltage (Vdc)",
    "Maximum voltage",
    "V",
    "Published maximum (BMS protection) voltage.",
  );
  number(
    "Min Voltage (Vdc)",
    "Minimum voltage",
    "V",
    "Published minimum (BMS protection) voltage.",
  );
  number(
    "Max Continuous Charge Current (Adc)",
    "Maximum continuous charge current",
    "A",
    "Published rating for one battery; temperature limits also apply.",
  );
  const discharge = number(
    "Max Continuous Discharge Current (Adc)",
    "Maximum continuous discharge current",
    "A",
    "Published rating for one battery; temperature limits also apply.",
  );
  const peak = number(
    "Max Peak Current (Adc)",
    "Maximum peak current",
    "A",
    "Peak only; duration is not stated on this page.",
  );
  if (discharge && peak && peak < discharge)
    throw new Error("Peak current below continuous current");
  // Tabs show different current columns of the same table, some blank; merge by current and
  // refuse only when one current carries two figures.
  const byCurrent = new Map();
  for (const minutes of tables(html).filter((t) => t[0]?.[0] === "Minutes of Discharge")) {
    if (minutes.length !== 3 || minutes[1].length !== minutes[2].length)
      throw new Error("Minutes-of-discharge table is ragged");
    for (const [i, current] of minutes[1].entries()) {
      if (!minutes[2][i]) continue;
      const amps = numeric(current.replace(/^@/, ""), "A"),
        mins = numeric(minutes[2][i]);
      if (byCurrent.has(amps) && byCurrent.get(amps) !== mins)
        throw new Error(`Tabs disagree on minutes of discharge at ${amps} A`);
      byCurrent.set(amps, mins);
    }
  }
  for (const [amps, mins] of [...byCurrent].sort((a, b) => a[0] - b[0])) {
    if (c1 && (amps * mins) / 60 > c1 * 1.3)
      throw new Error(`Discharge minutes at ${amps} A exceed capacity`);
    specifications.push(
      spec(
        `Discharge time at ${amps} A`,
        mins,
        "min",
        `Minutes of discharge at a constant ${amps} A, as published. Cutoff and temperature are not stated on this page.`,
      ),
    );
  }
  for (const [label, name] of [
    ["Charge Temperature", "Charge temperature range"],
    ["Discharge Temperature", "Discharge temperature range"],
    ["Cell(s)", "Cell configuration"],
    ["Industry Reference", "Industry reference"],
    ["Weight (lbs/kgs)", "Weight (lb)"],
  ]) {
    const value = get(label);
    if (value)
      specifications.push(
        spec(name, value.slice(0, 100), null, "As published on the product page."),
      );
  }
  if (!specifications.some((s) => ["Ah", "kWh"].includes(s.unit)))
    throw new Error("No published capacity or energy");
  return [
    makeRecord(
      "Discover",
      model,
      "battery",
      specifications.slice(0, 24),
      entry,
      manifest,
      revision,
      {
        source: { section: "Product specification tabs" },
        aliases: [{ brand: "Discover Battery", model }],
      },
    ),
  ];
}
