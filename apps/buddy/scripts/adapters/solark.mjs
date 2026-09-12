// Sol-Ark: one datasheet per model, a two-column "Specification | Unit | Rating"
// table on page 2. Column edges come from that header line on the same page, so
// a value is read by position and a blank cell stays blank.
import { makeRecord, numeric, spec } from "../manufacturer-adapters.mjs";
import { findLine, groups, pageOf } from "./pdf-text.mjs";

export const extract = "lines";
export function records(pages, entry, manifest, revision) {
  const page = pageOf(pages, 2);
  const modelLine = findLine(page, /^Model: /);
  const model = modelLine?.words[1]?.text;
  if (!model || modelLine.words.length !== 2) throw new Error(`No single Model: line on page 2`);
  if (model !== entry.model) throw new Error(`Sheet is for ${model}, feed says ${entry.model}`);
  // A figure legend can share the header's line, so find the six header words by text, not by position.
  // "Rating" can be glued to legend text ("Ratingpinouts") when the figure shares the line.
  const pick = (line, text) =>
    line.words.filter((w) => w.text === text || (text === "Rating" && w.text.startsWith("Rating")));
  // On some sheets the legend text is interleaved with "Rating" ("RInaptiuntg"); the rating
  // column then starts a fixed distance after the unit column, as it does on the clean sheets.
  const header = page.lines.find(
    (l) => pick(l, "Specification").length === 2 && pick(l, "Unit").length === 2,
  );
  if (!header) throw new Error("No two-column specification header");
  const [_s1, s2] = pick(header, "Specification"),
    [u1, u2] = pick(header, "Unit");
  const ratings = pick(header, "Rating");
  const [r1, r2] = ratings.length === 2 ? ratings : [{ x0: u1.x1 + 20 }, { x0: u2.x1 + 20 }];
  const halves = [
    { x0: 0, unit: u1.x0, rating: r1.x0, x1: s2.x0 - 4 },
    { x0: s2.x0 - 4, unit: u2.x0, rating: r2.x0, x1: page.width },
  ];
  const rows = [];
  for (const line of page.lines.filter((l) => l.top > header.top)) {
    for (const half of halves) {
      const words = line.words.filter((w) => w.x0 >= half.x0 && w.x0 < half.x1);
      const label = words
        .filter((w) => w.x1 <= half.unit - 2)
        .map((w) => w.text)
        .join(" ");
      const unit = words
        .filter((w) => w.x0 >= half.unit - 2 && w.x1 <= half.rating - 2)
        .map((w) => w.text)
        .join(" ");
      const value = groups(words.filter((w) => w.x0 >= half.rating - 2)).map((g) => g.text);
      if (label) rows.push({ label, unit, value });
    }
  }
  const get = (pattern) => {
    const hits = rows.filter((r) => pattern.test(r.label));
    if (hits.length > 1) throw new Error(`Duplicate row: ${pattern}`);
    return hits[0];
  };
  const number = (pattern, name, unit, conditions, pick = 0) => {
    const row = get(pattern);
    if (!row) return undefined;
    if (row.unit !== unit) throw new Error(`Unit changed for ${name}: ${row.unit}`);
    const value = numeric(row.value[pick].replace(/\s*\(per MPPT\)$/, ""), "");
    specifications.push(spec(name, value, unit, conditions));
    return value;
  };
  const specifications = [];
  const continuous = number(
    /^Max\. Continuous Power$/,
    "Continuous AC output power",
    "W",
    "Backup/off-grid continuous output at 240 V split phase, first rating column. Grid-tied real power is a separate figure.",
  );
  const surge = number(
    /^Peak Surge Power \(10 ?s\)$/,
    "Surge AC output power",
    "W",
    "For 10 seconds only, first rating column. Not continuous output.",
  );
  if (continuous && surge && surge < continuous) throw new Error("Surge below continuous power");
  number(
    /^Nominal Real Power \(240V\)$/,
    "Grid-tied real power",
    "W",
    "Nominal real power to the grid at 240 V; not the backup rating.",
  );
  number(
    /^Nominal DC Voltage$/,
    "Nominal battery voltage",
    "V",
    "Battery nominal voltage class; the operating range is a separate figure.",
  );
  const charge = get(/^Max\. Charge \/ Discharge Current$/);
  if (charge) {
    const m = charge.value.join(" ").match(/^(\d+) \/ (\d+)$/);
    if (!m || charge.unit !== "A") throw new Error("Unrecognized charge/discharge current");
    specifications.push(
      spec(
        "Maximum battery charge current",
        Number(m[1]),
        "A",
        "Battery-side charging, as published.",
      ),
      spec(
        "Maximum battery discharge current",
        Number(m[2]),
        "A",
        "Battery-side discharge, as published.",
      ),
    );
  }
  number(
    /^Max\. Usable Combined MPPT PV Power$/,
    "Maximum usable PV power",
    "W",
    "Usable combined MPPT input; STC-rated array power may be higher per the sheet.",
  );
  number(
    /^Max\. Input Voltage\d?$/,
    "Maximum PV input voltage",
    "V",
    "Array Voc at the minimum design temperature must stay below this.",
  );
  number(
    /^Max\. Operating PV Input Current$/,
    "Maximum PV operating current per MPPT",
    "A",
    "Per MPPT, as published.",
  );
  number(
    /^Max\. Input Short Circuit Current$/,
    "Maximum PV short-circuit current per MPPT",
    "A",
    "Per MPPT, as published.",
  );
  number(
    /^Max\. Passthrough Current \(Grid to Load\)$/,
    "Maximum grid passthrough current",
    "A",
    "Grid-to-load passthrough, as published.",
  );
  number(
    /^Idle Consumption - No Load$/,
    "Idle consumption",
    "W",
    "No-load consumption, as published.",
  );
  for (const [pattern, name] of [
    [/^Operating Voltage Range$/, "Battery operating voltage range"],
    [/^BMS Communication$/, "BMS communication"],
    [/^Rated Voltage \(L-N, L-L\)$/, "AC output voltage"],
    [/^Automatic Generator Start \(AGS\)$/, "Automatic generator start"],
    [/^Weight$/, "Weight"],
    [/^Ambient Temperature \/ De-rated$/, "Ambient temperature"],
  ]) {
    const row = get(pattern);
    if (row)
      specifications.push(
        spec(
          name,
          `${row.value.join(" ")}${row.unit ? ` ${row.unit}` : ""}`.slice(0, 100),
          null,
          name === "Automatic generator start"
            ? "As published. A two-wire start contact named on a datasheet is not a verified Origin89 integration."
            : "As published, with the sheet's unit.",
        ),
      );
  }
  if (!continuous) throw new Error("No continuous power rating");
  const revisionLine = findLine(page, /PS-\d+ Rev\. \d+/);
  return [
    makeRecord(
      "Sol-Ark",
      model,
      "inverter",
      specifications.slice(0, 24),
      entry,
      manifest,
      revision,
      {
        source: {
          title: `Sol-Ark ${model} datasheet`,
          page: 2,
          section: undefined,
          revision:
            revisionLine?.text.match(/PS-\d+ Rev\. \d+/)?.[0] ?? `Snapshot ${manifest.checkedAt}`,
        },
        limitations: [
          "Hybrid inverter ratings at 240 V split phase from the first rating column; 208 V and derated figures are on the sheet. Not a verified Origin89 integration.",
        ],
      },
    ),
  ];
}
