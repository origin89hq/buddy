// Yilink (Québec): static product pages with a label/value technical table headed
// by the model number. Family pages that quote several capacities "depending on
// reference" describe a range, not a product, and are refused.
import { document, nodes, tables, text } from "../catalogue-html.mjs";
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";

const site = "https://www.yilink.ca";
export async function discover(fetchHtml) {
  const sitemap = await fetchHtml(`${site}/sitemap.xml`);
  const urls = [
    ...new Set(
      [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1])
        .filter((u) => /^https:\/\/www\.yilink\.ca\/en\/products\/[a-z0-9-]+\/$/.test(u)),
    ),
  ];
  if (urls.length < 5 || urls.length > 60)
    throw new Error(`Unexpected Yilink product count: ${urls.length}`);
  return urls.map((url) => ({ adapter: "yilink", family: "LiFePO4 battery", url }));
}

export function records(html, entry, manifest, revision) {
  const root = document(html);
  const headings = nodes(root, (n) => /^h[1-4]$/.test(n.tagName ?? "")).map(text);
  const bodyText = nodes(root, (n) => n.nodeName === "#text")
    .map((n) => n.value.trim())
    .filter(Boolean);
  const labels = [
    ...new Set(bodyText.map((t) => t.match(/^Model (YL-[A-Z0-9-]+)$/)?.[1]).filter(Boolean)),
  ];
  if (labels.length !== 1) throw new Error(`Expected one model label, found ${labels.length}`);
  const [model] = labels;
  const captioned = bodyText
    .map((t) => t.match(/^Technical specifications — (YL-[A-Z0-9-]+)$/)?.[1])
    .filter(Boolean);
  if (captioned.some((c) => c !== model))
    throw new Error(`Technical table is captioned ${captioned} for model ${model}`);
  const table = tables(html).find((t) => t.some((r) => r[0] === "Nominal capacity"));
  if (!table) throw new Error("No single-model technical table");
  const get = (label) => {
    const rows = table.filter((r) => r[0] === label);
    if (rows.length > 1) throw new Error(`Duplicate row: ${label}`);
    return rows[0]?.[1];
  };
  if (get("Chemistry") !== "Lithium iron phosphate (LiFePO4)")
    throw new Error(`Unrecognized chemistry: ${get("Chemistry")}`);
  const voltage = get("Nominal voltage")?.match(
    /^(\d+(?:\.\d+)?) V \(range: (\d+(?:\.\d+)?) – (\d+(?:\.\d+)?) V\)$/,
  );
  if (!voltage) throw new Error(`Unrecognized nominal voltage: ${get("Nominal voltage")}`);
  const nominal = Number(voltage[1]),
    capacity = numeric(get("Nominal capacity"), "Ah"),
    energy = numeric(get("Nominal energy"), "kWh");
  if (Math.abs(energy * 1000 - nominal * capacity) > nominal * capacity * 0.03)
    throw new Error("Nominal energy disagrees with voltage × capacity");
  const specifications = [
    spec("Chemistry", "LiFePO4", null, "Manufacturer product classification."),
    spec(
      "Nominal voltage",
      nominal,
      "V",
      "Nominal voltage of one battery as published; not the installed bank voltage.",
    ),
    spec(
      "Operating voltage range",
      `${voltage[2]}–${voltage[3]} V`,
      null,
      "Published operating range of one battery.",
    ),
    spec(
      "Nominal capacity",
      capacity,
      "Ah",
      "Manufacturer nominal capacity; discharge rate and cutoff are not stated in this table.",
    ),
    spec(
      "Nominal energy",
      energy,
      "kWh",
      "Published nominal energy of one battery, not usable energy or present state of charge.",
    ),
  ];
  const powerRaw = get("Max. output power"),
    powerNote = powerRaw?.match(/^(.+?)\s*\((.+)\)$/),
    power = powerNote ? powerNote[1] : powerRaw;
  if (power)
    specifications.push(
      spec(
        "Maximum output power",
        numeric(power, "kW"),
        "kW",
        `Published maximum output${powerNote ? `, ${powerNote[2]}` : ""}; duration and temperature conditions are not stated in this table.`,
      ),
    );
  for (const [label, name] of [
    ["Recommended charge current", "Recommended charge current"],
    ["Max. continuous charge current", "Maximum continuous charge current"],
    ["Max. continuous discharge current", "Maximum continuous discharge current"],
  ]) {
    const raw = get(label),
      note = raw?.match(/^(.+?)\s*\((.+)\)$/);
    if (raw)
      specifications.push(
        spec(
          name,
          numeric(note ? note[1] : raw, "A"),
          "A",
          `Published rating for one battery${note ? `, ${note[2]}` : ""}; the BMS and temperature limits also apply.`,
        ),
      );
  }
  const discharge = specifications.find(
    (s) => s.name === "Maximum continuous discharge current",
  )?.value;
  if (power && discharge && numeric(power, "kW") * 1000 > discharge * Number(voltage[3]) * 1.05)
    throw new Error("Output power exceeds discharge current × maximum voltage");
  for (const [label, name] of [
    ["Charging temperature", "Charge temperature range"],
    ["Discharging temperature", "Discharge temperature range"],
    ["Communication", "Communication interfaces"],
    ["Parallel capability", "Parallel capability"],
    ["IP rating", "IP rating"],
    ["Net weight", "Net weight"],
    ["Dimensions (W × D × H)", "Dimensions (W × D × H)"],
    ["Cycle life", "Cycle life"],
  ]) {
    const value = get(label);
    if (value)
      specifications.push(
        spec(
          name,
          value.slice(0, 100),
          null,
          label === "Communication"
            ? "Ports named by the manufacturer. A port is not a verified Origin89 driver."
            : "As published in the technical table.",
        ),
      );
  }
  const marketing = headings.find(
    (h) => /^Yilink \S+ [A-Z0-9-]+$/.test(h) && h.endsWith(model.replace(/^YL-/, "")),
  );
  return [
    makeRecord("Yilink", model, "battery", specifications, entry, manifest, revision, {
      source: { section: `Technical specifications — ${model}` },
      aliases: [
        { brand: "Yilink", model: model.replace(/^YL-/, "") },
        ...(marketing ? [{ brand: "Yilink", model: marketing.replace(/^Yilink /, "") }] : []),
      ],
    }),
  ];
}
