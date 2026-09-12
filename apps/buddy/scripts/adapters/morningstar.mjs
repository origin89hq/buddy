// Morningstar: one WordPress page per family with a comparison table whose
// first row names the models. GenStar and SureSine put images in that row, so
// the column has no model text and the family is refused rather than guessed.
import { tables } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";

const site = "https://www.morningstarcorp.com";
// Charge-controller families. Meters, adapters and relays are on the same sitemap and are not equipment Buddy rates.
const families = [
  "tristar-mppt",
  "tristar-mppt-600v",
  "prostar-mppt",
  "sunsaver-mppt",
  "ecoboost-mppt",
  "genstar-mppt",
  "tristar",
  "prostar",
  "prostar-gen-1",
  "sunsaver",
  "sunsaver-gen-2",
  "sunsaver-duo",
  "sunkeeper",
  "sunguard",
];

export async function discover(fetchHtml) {
  const sitemap = await fetchHtml(`${site}/products-sitemap.xml`);
  const listed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  const missing = families.filter((slug) => !listed.has(`${site}/products/${slug}/`));
  if (missing.length)
    throw new Error(`Families absent from the Morningstar sitemap: ${missing.join(", ")}`);
  return families.map((slug) => ({
    adapter: "morningstar",
    family: slug,
    url: `${site}/products/${slug}/`,
  }));
}

const modelPattern = /^(?:[A-Z]{2,3}(?:-MPPT)?-[A-Z0-9-]+|SunKeeper SK-\d+)$/;
export function records(html, entry, manifest, revision) {
  const table = tables(html).find((t) => t[0]?.[0] === "Model");
  if (!table) throw new Error("No model comparison table");
  const header = table[0];
  if (!header.slice(1).every((m) => modelPattern.test(m)))
    throw new Error(`Model row is not model text: ${header.slice(1).join(" | ").slice(0, 120)}`);
  const result = [];
  for (let column = 1; column < header.length; column++) {
    const model = header[column];
    const get = (pattern) => {
      const rows = table.filter((r) => pattern.test(r[0]));
      if (rows.length > 1) throw new Error(`Duplicate row: ${pattern}`);
      return rows[0]?.[column];
    };
    const charge = numeric(get(/^Charge Rating$/), "amps");
    const voc = get(/^Max\. PV Open Circuit Voltage \(Voc\)/);
    const supported = get(/^Nominal Battery Voltage$/);
    if (!voc || !supported)
      throw new Error(`Missing PV voltage or battery voltage row for ${model}`);
    const specifications = [
      spec(
        "Maximum charge current",
        charge,
        "A",
        "Battery-side charging rating. Not PV input current; Morningstar rates it at the table's ambient conditions.",
      ),
      spec(
        "Supported battery voltage",
        supported,
        null,
        "Nominal battery voltages from the comparison table. Selection may be automatic or programmed depending on the model.",
      ),
    ];
    const single = voc.match(/^(\d+) volts$/);
    if (single)
      specifications.push(
        spec(
          "Maximum PV open-circuit voltage",
          Number(single[1]),
          "V",
          "Array Voc must stay below this limit at the coldest expected temperature; the table does not state a temperature.",
        ),
      );
    else if (/^\d+\/\d+ volts$/.test(voc))
      specifications.push(
        spec(
          "Maximum PV open-circuit voltage",
          voc,
          null,
          "Limit per nominal battery voltage (12 V / 24 V), as published. Array Voc must stay below the applicable value.",
        ),
      );
    else throw new Error(`Unrecognized PV voltage limit: ${voc}`);
    let powerAt12;
    for (const row of table.filter((r) =>
      /^Nominal max\. Operating Power\*+ – \d+ volt batter/.test(r[0]),
    )) {
      const volts = Number(row[0].match(/(\d+) volt/)[1]);
      const raw = row[column].replace(/\s*@\d+C$/, "");
      const watts = numeric(raw, "W");
      if (volts === 12) powerAt12 = watts;
      // A charge rating and a 12 V power figure that disagree by more than a diode drop are two different products in one column.
      if (volts === 12 && (watts / charge < 11 || watts / charge > 16.5))
        throw new Error(`Power and charge rating disagree for ${model}`);
      if (
        powerAt12 &&
        volts !== 12 &&
        Math.abs(watts - (powerAt12 * volts) / 12) > ((powerAt12 * volts) / 12) * 0.1
      )
        throw new Error(`Power does not scale with voltage for ${model}`);
      specifications.push(
        spec(
          `Nominal PV power at ${volts} V`,
          watts,
          "W",
          `Nominal maximum operating power at ${volts} V battery voltage${row[column].includes("@") ? `, ${row[column].match(/@\d+C/)[0].replace("@", "at ").replace("C", " °C")}` : ""}. Input may exceed this within the voltage and current limits; it is not an array-size ceiling.`,
        ),
      );
    }
    for (const [pattern, name] of [
      [/^Battery Operating Voltage Range$/, "Battery operating voltage range"],
      [/^Minimum Battery Voltage$/, "Minimum battery voltage"],
      [/^Operating Temperature Range$/, "Operating temperature range"],
      [/^Self[- ]Consumption$/, "Self consumption"],
      [/^Peak efficiency$/, "Peak efficiency"],
    ]) {
      const value = get(pattern);
      if (value)
        specifications.push(
          spec(name, value.slice(0, 100), null, "As published on the comparison table."),
        );
    }
    result.push(
      makeRecord(
        "Morningstar",
        model,
        "charge-controller",
        specifications,
        entry,
        manifest,
        revision,
        {
          source: { section: "Family comparison table" },
          limitations: [
            "Nominal PV watts are an operating rating at the stated battery voltage, not a hard PV input limit. Voc and current limits still apply.",
          ],
        },
      ),
    );
  }
  if (!result.length) throw new Error("No models in comparison table");
  return result;
}
