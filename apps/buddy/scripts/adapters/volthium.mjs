// Volthium (Québec): identity from the WooCommerce store feed (name and SKU),
// ratings from the French "fiche technique" PDF listed on the documents page.
// A datasheet is published only when exactly one store product claims it, either
// by linking it or by being the only product with that voltage and capacity.
import { attr, document, nodes } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";
import { groups } from "./pdf-text.mjs";

export const extract = "lines";
const store = "https://volthium.com/wp-json/wc/store/v1/products?per_page=100";
const documents = "https://volthium.com/fr/documents/";
const nameKey = (name) => name.match(/(\d+(?:\.\d+)?)\s*V\s+(\d+)\s*Ah/i);

export async function discover(fetchText) {
  const products = JSON.parse(await fetchText(store)).filter(
    (p) => /^(12\.8|25\.6|51\.2)-/.test(p.sku ?? "") && !/Ensemble|Support|Rack pour/.test(p.name),
  );
  const sheets = [
    ...new Set(
      nodes(document(await fetchText(documents)), (n) => n.tagName === "a")
        .map((n) => attr(n, "href") ?? "")
        .filter((u) => /volthium\.com\/wp-content\/uploads\/.*Fiche[^/]*\.pdf$/i.test(u)),
    ),
  ];
  const entries = [];
  for (const url of sheets.sort()) {
    const linked = products.filter((p) => (p.description ?? "").includes(url));
    const byName = products.filter((p) => {
      const k = nameKey(p.name);
      return (
        k &&
        new RegExp(`(^|[_-])${k[1].replace(".", "\\.")}-?V-?${k[2]}-?A[Hh]`, "i").test(
          url.split("/").pop(),
        )
      );
    });
    const claim =
      linked.length === 1
        ? { product: linked[0], matchedBy: "store-link" }
        : linked.length === 0 && byName.length === 1
          ? { product: byName[0], matchedBy: "voltage-capacity-name" }
          : null;
    const product = claim?.product;
    entries.push({
      adapter: "volthium",
      family: "LiFePO4 battery",
      url,
      ...(product
        ? {
            model: product.name
              .replace(/^Batterie\s+/i, "")
              .replace(/&#8211;|–/g, "-")
              .replace(/\s+/g, " ")
              .trim(),
            sku: product.sku,
            productUrl: product.permalink,
            matchedBy: claim.matchedBy,
          }
        : { unmatched: `${linked.length} linked, ${byName.length} by name` }),
    });
  }
  // Two sheets naming the same product by voltage and capacity is two candidates, not a match.
  const claims = new Map();
  for (const e of entries)
    if (e.sku && e.matchedBy !== "store-link") claims.set(e.sku, (claims.get(e.sku) ?? 0) + 1);
  for (const e of entries)
    if (e.sku && e.matchedBy !== "store-link" && claims.get(e.sku) > 1) {
      e.unmatched = `${claims.get(e.sku)} sheets name ${e.sku}`;
      delete e.model;
      delete e.sku;
      delete e.productUrl;
      delete e.matchedBy;
    }
  if (entries.length < 10)
    throw new Error(`Unexpected Volthium datasheet count: ${entries.length}`);
  return entries;
}

const fields = [
  [
    /^Voltage$/,
    "Nominal voltage",
    "volt",
    "V",
    "Nominal voltage of one battery; not the installed bank voltage.",
  ],
  [
    /^Capacité$/,
    "Nominal capacity",
    "Ah",
    "Ah",
    "Manufacturer nominal capacity; discharge rate and cutoff are not stated on the sheet.",
  ],
  [
    /^Énergie$/,
    "Nominal energy",
    /^(k?)Wh$/i,
    "Wh",
    "Published nominal energy of one battery, not usable energy or present state of charge.",
  ],
  [
    /^Courant de charge recommandé$/,
    "Recommended charge current",
    "A",
    "A",
    "Published rating for one battery; the BMS and temperature limits also apply.",
  ],
  [
    /^Courant de charge maximum$/,
    "Maximum charge current",
    "A",
    "A",
    "Published rating for one battery; the BMS and temperature limits also apply.",
  ],
  [
    /^Courant de décharge continue$/,
    "Maximum continuous discharge current",
    "A",
    "A",
    "Published continuous rating for one battery; the BMS limits also apply.",
  ],
];
export function records(pages, entry, manifest, revision) {
  if (!entry.model || !entry.sku)
    throw new Error(
      `No single store product claims this datasheet (${entry.unmatched ?? "unmatched"})`,
    );
  // 2025 sheets put the table on page 2 in one column; 2024 sheets put it on page 1 in two.
  // In both, the label and its value are separated by a wide gap and the value starts with a figure.
  const page = pages.find(
    (p) =>
      p.lines.some((l) => /^Voltage /.test(l.text)) &&
      p.lines.some((l) => /^Capacité /.test(l.text)),
  );
  if (!page) throw new Error("No page with Voltage and Capacité rows");
  const rows = page.lines
    .map((l) => {
      const g = groups(l.words, 30);
      return { label: g[0]?.text ?? "", value: g[1] && /^[\d<>]/.test(g[1].text) ? g[1].text : "" };
    })
    .filter((r) => r.label && r.value);
  const get = (pattern) => {
    const hits = rows.filter((r) => pattern.test(r.label));
    if (hits.length > 1) throw new Error(`Duplicate row: ${pattern}`);
    return hits[0]?.value;
  };
  const specifications = [
    spec("Chemistry", "LiFePO4", null, "Manufacturer product classification."),
  ];
  for (const [pattern, name, unit, outUnit, conditions] of fields) {
    const raw = get(pattern);
    if (raw === undefined) continue;
    // "300 A pendant 30 min | 325 A pendant 10 min" is two time-limited ratings and "5 A - 80 A"
    // is a range; neither is one number, so both stay as published text.
    if (/pendant|\||-/.test(raw) && !/^Voltage|Capacité|Énergie/.test(pattern.source)) {
      specifications.push(
        spec(
          name,
          raw.slice(0, 100),
          null,
          `${conditions} Range or time-limited figures as published.`,
        ),
      );
      continue;
    }
    // "16.1 KWh" on the 51.2 V sheets is kilowatt-hours; the record keeps watt-hours.
    if (unit instanceof RegExp) {
      const m = raw.match(/^(\d+(?:[.,]\d+)?)\s*(k?)Wh$/i);
      if (!m) throw new Error(`Invalid Wh quantity: ${raw}`);
      specifications.push(
        spec(name, Number(m[1].replace(",", ".")) * (m[2] ? 1000 : 1), outUnit, conditions),
      );
      continue;
    }
    specifications.push(spec(name, numeric(raw, unit), outUnit, conditions));
  }
  const volts = specifications.find((s) => s.name === "Nominal voltage")?.value,
    ah = specifications.find((s) => s.name === "Nominal capacity")?.value,
    wh = specifications.find((s) => s.name === "Nominal energy")?.value;
  if (!volts || !ah) throw new Error("Datasheet has no voltage and capacity rows");
  if (wh && Math.abs(wh - volts * ah) > volts * ah * 0.03)
    throw new Error("Nominal energy disagrees with voltage × capacity");
  const key = entry.model.match(/(\d+(?:\.\d+)?)\s*V\s+(\d+)\s*Ah/i);
  // The store names the class (12, 24, 48 V); the sheet gives the LiFePO4 nominal (12.8, 25.6, 51.2 V).
  const named = key && Number(key[1]),
    classMatches =
      named && (Math.abs(named - volts) <= 1 || Math.abs((named * 16) / 15 - volts) <= 0.2);
  if (!key || Number(key[2]) !== ah || !classMatches)
    throw new Error(`Store product ${entry.model} does not match the sheet's ${volts} V ${ah} Ah`);
  const minutes = get(/^Capacité @ (\d+)A$/);
  if (minutes) {
    const amps = Number(
        rows.find((r) => /^Capacité @ \d+A$/.test(r.label)).label.match(/(\d+)A/)[1],
      ),
      mins = numeric(minutes, "min");
    if ((amps * mins) / 60 > ah * 1.05) throw new Error("Discharge minutes exceed capacity");
    specifications.push(
      spec(
        `Discharge time at ${amps} A`,
        mins,
        "min",
        `Minutes of discharge at a constant ${amps} A, as published.`,
      ),
    );
  }
  const charge = get(/^Voltage de charge recommandé$/);
  if (charge)
    specifications.push(
      spec(
        "Recommended charge voltage",
        charge.slice(0, 100),
        null,
        "Bulk and float as published; follow the manufacturer charging instructions.",
      ),
    );
  for (const [pattern, name] of [
    [/^BMS - Voltage de déconnexion en décharge$/, "BMS discharge cutoff voltage"],
    [/^Courant de décharge MAX autorisé$/, "Maximum peak discharge current"],
  ]) {
    const raw = get(pattern);
    if (raw)
      specifications.push(
        spec(
          name,
          raw.slice(0, 100),
          null,
          "As published on the sheet; duration conditions are in the value.",
        ),
      );
  }
  return [
    makeRecord("Volthium", entry.model, "battery", specifications, entry, manifest, revision, {
      source: {
        title: `Volthium fiche technique ${entry.model}`.slice(0, 150),
        page: page.page,
        section: undefined,
        revision: `Snapshot ${manifest.checkedAt}`,
      },
      aliases: [{ brand: "Volthium", model: entry.sku }],
      limitations: [
        `Identity from the store product ${entry.productUrl}, matched to this sheet by ${entry.matchedBy}.`.slice(
          0,
          200,
        ),
      ],
    }),
  ];
}
