// DuroMax / DuroStar: the Shopify products feed. Every generator body carries
// specification tables per fuel plus engine and panel tables. The model is the
// "Part #" row, which must agree with the variant SKU, and the brand is the feed's
// vendor field because DuroStar is sold on the DuroMax store.
import { tables } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";

const feed = (page) => `https://www.duromaxpower.com/products.json?limit=250&page=${page}`;
export async function discover(fetchJson) {
  const entries = [];
  for (let page = 1; page <= 10; page++) {
    const products = (await fetchJson(feed(page))).products;
    if (!Array.isArray(products)) throw new Error("DuroMax feed is not a Shopify products list");
    if (!products.length) break;
    entries.push({
      adapter: "duromax",
      family: "generator",
      format: "json",
      page,
      url: feed(page),
    });
    if (products.length < 250) break;
  }
  if (!entries.length) throw new Error("Empty DuroMax feed");
  return entries;
}

const fuelPattern = /^(Gasoline|Propane|Natural Gas)$/;
// Some bodies write "9,500" and others "9,500 W"; the unit is the table's, not the cell's.
const watts = (raw) => numeric(String(raw ?? "").replace(/\s*(?:W|Watts)$/i, ""));
// "21.5 Hrs.", "19.9 hr", "16 hrs", "25 hrs (60 lb.)" are hours. "12 / 18 / 30 hrs" is three tanks and
// "17" has no unit; neither is a single published figure, so both are left out rather than guessed.
const hours = (raw) => {
  const m = String(raw ?? "").match(/^(\d+(?:\.\d+)?)\s*(?:hours|hrs?|h)\.?(?:\s*\((.+)\))?$/i);
  return m ? { value: Number(m[1]), note: m[2] } : undefined;
};
// One feed page holds many products, so a product that fails is quarantined by
// handle and the rest of the page still publishes.
export function records(json, entry, manifest, revision) {
  const products = JSON.parse(json).products;
  if (!Array.isArray(products)) throw new Error("Not a Shopify products page");
  const result = [],
    rejected = [];
  for (const product of products) {
    if (product.product_type !== "Generators") continue;
    try {
      result.push(generator(product, entry, manifest, revision));
    } catch (error) {
      rejected.push({
        model: product.variants?.[0]?.sku,
        url: `https://www.duromaxpower.com/products/${product.handle}`,
        reason: error.message,
      });
    }
  }
  // A feed page of parts and covers is a valid page with nothing to publish.
  return { records: result, rejected };
}

function generator(product, entry, manifest, revision) {
  const ts = tables(product.body_html ?? "");
  const general = ts.find((t) => t[0]?.[0] === "Generator Specifications");
  const engine = ts.find((t) => t[0]?.[0] === "Engine & Emission Specifications");
  const row = (table, label) => {
    const rows = (table ?? []).filter((r) => r[0] === label);
    if (rows.length > 1) throw new Error(`Duplicate row: ${label}`);
    return rows[0]?.[1];
  };
  const model = row(general, "Part #"),
    skus = product.variants?.map((v) => v.sku) ?? [];
  if (!model || skus.length !== 1 || skus[0] !== model)
    throw new Error(
      `Part number ${model} and variant SKUs ${skus.join(",")} disagree for ${product.handle}`,
    );
  if (!["DuroMax", "DuroStar"].includes(product.vendor))
    throw new Error(`Unexpected vendor ${product.vendor}`);
  const specifications = [];
  for (const fuel of ts.filter((t) => fuelPattern.test(t[0]?.[0] ?? ""))) {
    const name = fuel[0][0].toLowerCase(),
      peak = watts(row(fuel, "Peak Wattage")),
      running = watts(row(fuel, "Running Wattage"));
    if (running >= peak) throw new Error(`Running power is not below peak on ${name} for ${model}`);
    specifications.push(
      spec(
        `Continuous AC output power (${name})`,
        running,
        "W",
        `Running watts on ${name}, as published. Not starting/peak power; derates with altitude and temperature.`,
      ),
    );
    specifications.push(
      spec(
        `Peak AC output power (${name})`,
        peak,
        "W",
        `Starting/peak watts on ${name}, as published; momentary only.`,
      ),
    );
    for (const r of fuel.filter((r) => /^Runtime at \d+% [Ll]oad/.test(r[0]))) {
      const parsed = hours(r[1]),
        load = r[0].match(/(\d+)%/)[1],
        tank = r[0].match(/\((.+)\)$/)?.[1] ?? parsed?.note;
      const label = `Run time at ${load} % load (${name})${tank ? ` with ${tank}` : ""}`.slice(
        0,
        80,
      );
      if (!parsed || specifications.some((s) => s.name === label)) continue;
      specifications.push(
        spec(
          label,
          parsed.value,
          "h",
          `${tank ? `With ${tank} of ${name}` : `On the built-in tank of ${name}`}, as published. Load and fuel condition per the manufacturer table.`,
        ),
      );
    }
  }
  if (!specifications.length) throw new Error(`No fuel tables for ${model}`);
  for (const [label, name, conditions] of [
    ["Voltage", "AC output voltage", "Published output voltage; single or split phase as stated."],
    ["Frequency", "AC output frequency", "Published output frequency."],
    [
      "THD (Total Harmonic Distortion)",
      "Total harmonic distortion",
      "Published THD; a figure under 5 % is what sensitive electronics need.",
    ],
    [
      "Total Harmonic Distortion (THD)",
      "Total harmonic distortion",
      "Published THD; a figure under 5 % is what sensitive electronics need.",
    ],
    ["Fuel Tank Capacity Gasoline", "Gasoline tank capacity", "Published tank capacity."],
    ["Product Dry Weight", "Dry weight", "Published dry weight without fuel."],
    [
      "Volume @ 25% Load (db)",
      "Noise at 25 % load",
      "Published noise figure; distance is not stated.",
    ],
  ]) {
    const value = row(general, label);
    if (value) specifications.push(spec(name, value.slice(0, 100), null, conditions));
  }
  for (const [label, name] of [
    ["Starting Type", "Starting type"],
    ["Remote Start", "Remote start"],
    ["Electric Start", "Electric start"],
    ["Engine Size", "Engine displacement"],
    ["Fuel Types", "Fuel types"],
    ["Automatic Low Oil Shutdown", "Automatic low-oil shutdown"],
    ["CO Sensor Shutdown", "CO sensor shutdown"],
  ]) {
    const value = row(engine, label);
    if (value)
      specifications.push(
        spec(
          name,
          value.slice(0, 100),
          null,
          name === "Remote start"
            ? "Manufacturer's remote start is the supplied key fob. It is not a documented two-wire start input; that needs the manual."
            : "As published in the engine table.",
        ),
      );
  }
  return makeRecord(
    product.vendor,
    model,
    "generator",
    specifications.slice(0, 24),
    entry,
    manifest,
    revision,
    {
      source: {
        title: `${product.vendor} ${product.title}`.slice(0, 150),
        section: `Shopify feed product ${product.handle}`.slice(0, 120),
      },
      limitations: [
        "Portable generator ratings from the manufacturer store feed. Two-wire start capability and inverter/charger compatibility are not established by this record.",
      ],
    },
  );
}
