// OutBack Power FXR/VFXR: one spec sheet per series with a "Models:" line naming
// six columns. Read by column band from that line.
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";
import { cells, columnGrid } from "./pdf-text.mjs";

export const extract = "lines";
export function records(pages, entry, manifest, revision) {
  const page = pages.find((p) => p.lines.some((l) => /^Models: /.test(l.text)));
  if (!page) throw new Error("No Models: line");
  const headerLine = page.lines.find((l) => /^Models: /.test(l.text));
  const modelWords = headerLine.words.slice(1);
  if (!modelWords.every((w) => /^V?FXR\d{4}[AE]$/.test(w.text)))
    throw new Error(`Unrecognised models: ${headerLine.text}`);
  const grid = columnGrid(modelWords);
  const rows = page.lines.filter((l) => l.top > headerLine.top).map((l) => cells(l, grid));
  const get = (pattern, column) => {
    const hits = rows.filter((r) => pattern.test(r.label));
    if (hits.length > 1) throw new Error(`Duplicate row: ${pattern}`);
    return hits[0]?.values[column];
  };
  return modelWords.map((word, column) => {
    const model = word.text;
    const continuous = numeric(get(/^Continuous Power Rating/, column), "VA"),
      surge = numeric(get(/^Surge Power \(5 sec\)$/, column), "VA");
    if (surge < continuous) throw new Error(`Surge below continuous for ${model}`);
    const dc = numeric(get(/^Nominal DC Input Voltage$/, column), "VDC");
    if (Number(model.match(/(\d\d)[AE]$/)[1]) !== dc)
      throw new Error(`Model suffix and DC voltage disagree for ${model}`);
    const specifications = [
      spec(
        "Continuous AC output power",
        continuous,
        "VA",
        "At 25 °C, as published; apparent power (VA), not watts.",
      ),
      spec("Surge AC output power", surge, "VA", "For 5 seconds only, as published."),
      spec(
        "Nominal DC input voltage",
        dc,
        "V",
        "Battery nominal voltage of this model; not the AC output voltage.",
      ),
      spec(
        "Maximum battery charge current",
        numeric(get(/^Continuous Battery Charge Output$/, column), "ADC"),
        "A",
        "Continuous charger output, as published.",
      ),
    ];
    for (const [pattern, name] of [
      [/^AC Output Voltage/, "AC output voltage"],
      [/^Continuous AC Output Current/, "Continuous AC output current"],
      [/^DC Input Voltage Range$/, "DC input voltage range"],
      [/^Typical Efficiency$/, "Typical efficiency"],
      [/^Idle Power$/, "Idle power"],
      [/^Weight \(lb\/kg\)$/, "Weight (lb/kg)"],
    ]) {
      const value = get(pattern, column);
      if (value)
        specifications.push(
          spec(name, value.slice(0, 100), null, "As published on the spec sheet."),
        );
    }
    return makeRecord(
      "OutBack Power",
      model,
      "inverter-charger",
      specifications,
      entry,
      manifest,
      revision,
      {
        source: {
          title: `OutBack ${entry.family} spec sheet`,
          page: page.page,
          section: undefined,
        },
        limitations: [
          "Spec-sheet ratings. MATE3s or other OutBack network integration is not a verified Origin89 integration.",
        ],
      },
    );
  });
}
