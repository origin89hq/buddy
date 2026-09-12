// Schneider Electric Conext XW Pro: one datasheet, two configuration columns
// (120/240 V split phase and 120 V) of the same part number. The split-phase
// column is the record; the 120 V column is kept as separate configuration specs.
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";
import { cells, columnGrid, pageOf } from "./pdf-text.mjs";

export const extract = "lines";
export function records(pages, entry, manifest, revision) {
  const page = pageOf(pages, 2);
  const headerLine = page.lines.find((l) => /^XW Pro \d{4} NA XW Pro \d{4} NA$/.test(l.text));
  if (!headerLine) throw new Error("No two-configuration model header");
  const configLine = page.lines.find((l) => l.top > headerLine.top && /V/.test(l.text));
  const modelWords = [headerLine.words[3], headerLine.words[7]].map((w, i) => ({
    x0: headerLine.words[i * 4].x0,
    x1: w.x1,
    text: `XW Pro ${w.text === "NA" ? headerLine.words[i * 4 + 2].text : w.text} NA`,
  }));
  const grid = columnGrid(modelWords),
    configs = cells(configLine, grid).values;
  if (!/^120\/240 V$/.test(configs[0] ?? "") || !/^120 V$/.test(configs[1] ?? ""))
    throw new Error(`Unexpected configurations: ${configs.join(" | ")}`);
  const rows = page.lines.filter((l) => l.top > configLine.top).map((l) => cells(l, grid));
  const get = (pattern, column) => {
    const hits = rows.filter((r) => pattern.test(r.label));
    if (hits.length > 1) throw new Error(`Duplicate row: ${pattern}`);
    return hits[0]?.values[column];
  };
  const part = get(/^Part number$/, 0);
  if (!part || !/^\d{3}-\d{4}-\d{2}$/.test(part)) throw new Error(`No part number: ${part}`);
  const specifications = [];
  for (const [column, config] of configs.entries()) {
    const suffix = column ? ` (${config} configuration)` : "";
    const continuous = numeric(get(/^Output power \(continuous\) at 25°C$/, column), "W");
    const overload = get(/^Overload 30 min\/60 sec at 25°C$/, column)?.match(/^(\d+) W\/(\d+) W$/);
    if (!overload || Number(overload[2]) < continuous)
      throw new Error("Overload ratings missing or below continuous");
    specifications.push(
      spec(
        `Continuous AC output power${suffix}`,
        continuous,
        "W",
        `Standalone output at 25 °C, ${config}; derated at 40 °C per the sheet.`,
      ),
    );
    specifications.push(
      spec(
        `30-minute overload power${suffix}`,
        Number(overload[1]),
        "W",
        `${config}, 30 minutes at 25 °C.`,
      ),
      spec(
        `60-second overload power${suffix}`,
        Number(overload[2]),
        "W",
        `${config}, 60 seconds at 25 °C.`,
      ),
    );
    specifications.push(
      spec(
        `Maximum battery charge current${suffix}`,
        numeric(get(/^Maximum output charge current$/, column), "A"),
        "A",
        `Charger DC output, ${config}, as published.`,
      ),
    );
    if (column === 0) {
      for (const [pattern, name] of [
        [/^Input DC voltage range$/, "DC input voltage range"],
        [/^Maximum input DC current$/, "Maximum DC input current"],
        [/^Output voltage$/, "AC output voltage"],
        [/^Idle consumption search mode$/, "Idle consumption (search mode)"],
        [/^Compatible battery types$/, "Compatible battery types"],
        [/^Peak$/, "Peak efficiency"],
        [/^Product\/shipping weight$/, "Product/shipping weight"],
        [/^Operating air temperature range$/, "Operating temperature range"],
      ]) {
        const value = get(pattern, 0);
        if (value)
          specifications.push(
            spec(name, value.slice(0, 100), null, "As published on the datasheet."),
          );
      }
    }
  }
  return [
    makeRecord(
      "Schneider Electric",
      `Conext ${modelWords[0].text}`,
      "inverter-charger",
      specifications.slice(0, 24),
      entry,
      manifest,
      revision,
      {
        source: {
          title: "Schneider Electric Conext XW Pro datasheet",
          page: 2,
          section: undefined,
        },
        aliases: [
          { brand: "Schneider Electric", model: part },
          { brand: "Schneider", model: modelWords[0].text },
        ],
        limitations: [
          "Datasheet ratings. Xanbus or Insight integration is not a verified Origin89 integration.",
        ],
      },
    ),
  ];
}
