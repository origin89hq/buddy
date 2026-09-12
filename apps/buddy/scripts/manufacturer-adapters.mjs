import { createHash } from "node:crypto";
import { identityKey, knowledgeRecordSchema } from "../src/knowledge.ts";
import { document, nodes, tables, text } from "./catalogue-html.mjs";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
export function numeric(raw, unit = "") {
  const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "1,000W" and "8,000 W" are thousands separators on Morningstar and DuroMax pages, not decimals.
  const match = String(raw)
    .trim()
    .replace(/(\d),(\d{3})/g, "$1$2")
    .match(new RegExp(`^((?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s*${escaped}$`, "i"));
  if (!match || Number(match[1]) <= 0) throw new Error(`Invalid ${unit} quantity: ${raw}`);
  return Number(match[1]);
}
export const spec = (name, value, unit, conditions) => ({ name, value, unit, conditions });
export function makeRecord(
  brand,
  model,
  kind,
  specifications,
  entry,
  manifest,
  revision,
  extras = {},
) {
  return knowledgeRecordSchema.parse({
    id: `mfr-${revision.slice(0, 16)}-${sha(identityKey(brand, model)).slice(0, 24)}`,
    brand,
    model,
    kind,
    aliases:
      extras.aliases ??
      (brand === "Rolls"
        ? [
            { brand: "Rolls Battery", model },
            { brand: "Surrette", model },
          ]
        : brand === "Victron Energy"
          ? [{ brand: "Victron", model }]
          : []),
    review: {
      status: "verified",
      checkedAt: manifest.checkedAt,
      reviewedBy: "Manufacturer adapter: pinned source, identity, units and consistency validation",
    },
    source: {
      type: "manufacturer-document",
      title: `${brand} ${entry.family ?? "battery"} specifications`,
      url: entry.url,
      sha256: entry.sha256,
      section: "Technical specifications",
      revision: `Snapshot ${manifest.checkedAt}`,
      ...extras.source,
    },
    specifications,
    limitations: [
      "Published product ratings, not measured condition, verified installation wiring or Origin89 driver compatibility.",
      "Exact model and revision required. Charging settings and maintenance procedures require the applicable manufacturer instructions.",
      ...(extras.limitations ?? []),
    ],
  });
}

export function rollsRecords(html, entry, manifest, revision) {
  const ts = tables(html),
    rows = ts.flat();
  const title = ts[0]?.[0];
  if (title?.[1] !== entry.model)
    throw new Error(`Model differs from catalogue: ${title?.[1]} != ${entry.model}`);
  const headings = title[0].toUpperCase();
  const chemistry = headings.includes("FLOODED")
    ? "Flooded lead-acid"
    : headings.includes("AGM")
      ? "AGM lead-acid"
      : headings.includes("GEL")
        ? "Gel lead-acid"
        : headings.includes("LIFEPO4")
          ? "LiFePO4"
          : null;
  if (!chemistry) throw new Error(`Unrecognized battery chemistry: ${headings}`);
  const get = (label) => {
    const values = [
      ...new Set(rows.filter((r) => r[0] === label && r[1] !== label).map((r) => r[1])),
    ];
    if (values.length > 1) throw new Error(`Conflicting ${label}`);
    return values[0];
  };
  const voltageClass = numeric(get("Volts"));
  const nominal = get("Nominal Voltage")
    ? numeric(get("Nominal Voltage"), "V")
    : chemistry === "LiFePO4"
      ? null
      : voltageClass;
  const specifications = [
    spec("Chemistry", chemistry, null, "Manufacturer product classification."),
    spec(
      "Voltage class",
      voltageClass,
      "V",
      "Marketed voltage class of one battery; not the installed bank voltage.",
    ),
  ];
  if (nominal)
    specifications.push(
      spec(
        "Nominal voltage",
        nominal,
        "V",
        "Nominal voltage of one battery; not the installed bank voltage.",
      ),
    );
  const rateRows = rows.filter((r) => /^@ \d+ Hour Rate$/.test(r[0]));
  const seenRates = new Set();
  // C20 first for ordinary capacity questions; retain every published discharge duration.
  rateRows.sort((a, b) => (a[0] === "@ 20 Hour Rate" ? -1 : b[0] === "@ 20 Hour Rate" ? 1 : 0));
  let previousRate = 0,
    previousCapacity = 0;
  for (const row of [...rateRows].sort(
    (a, b) => Number(a[0].match(/\d+/)[0]) - Number(b[0].match(/\d+/)[0]),
  )) {
    const hours = Number(row[0].match(/\d+/)[0]),
      capacity = numeric(row[1], "AH"),
      current = numeric(row[2], "A");
    if (
      seenRates.has(hours) ||
      Math.abs(capacity - current * hours) > Math.max(1.5, capacity * 0.015) ||
      (hours > previousRate && capacity < previousCapacity)
    )
      throw new Error(`Inconsistent capacity table at C${hours}`);
    seenRates.add(hours);
    previousRate = hours;
    previousCapacity = capacity;
  }
  for (const row of rateRows) {
    const hours = Number(row[0].match(/\d+/)[0]);
    specifications.push(
      spec(
        `Capacity C${hours}`,
        numeric(row[1], "AH"),
        "Ah",
        `${hours}-hour discharge at ${numeric(row[2], "A")} A test current, as published. Test current is not a maximum discharge rating; cutoff not specified in this table.`,
      ),
    );
  }
  if (get("Nominal Capacity"))
    specifications.push(
      spec(
        "Nominal capacity",
        numeric(get("Nominal Capacity"), "AH"),
        "Ah",
        "Manufacturer nominal capacity; discharge duration and test conditions not stated in this table.",
      ),
    );
  if (!specifications.some((s) => s.unit === "Ah")) throw new Error("No published Ah rating");
  const currents = [
    ["Recommended Charge Current", "Recommended charge current"],
    ["Maximum Charge Current", "Maximum charge current"],
    ["Max Continuous Charge Current", "Maximum continuous charge current"],
    ["Max Continuous Discharge Current", "Maximum continuous discharge current"],
  ];
  for (const [label, name] of currents) {
    const raw = get(label);
    if (raw)
      specifications.push(
        spec(
          name,
          numeric(raw, "A"),
          "A",
          "Published rating for one battery. Temperature restrictions and manufacturer charging instructions also apply.",
        ),
      );
  }
  for (const row of rows.filter((r) => /^-?\d+~\d+°C/.test(r[0]) && r.length === 3)) {
    if (!specifications.some((s) => s.name === `Recommended charge current (${row[0]})`))
      specifications.push(
        spec(
          `Recommended charge current (${row[0]})`,
          numeric(row[2], "A"),
          "A",
          `Only at ${row[0]}, ${row[1]} rate. Follow the applicable manufacturer charging instructions.`,
        ),
      );
  }
  const energy = get("Total Energy");
  if (energy) {
    const value = numeric(energy, "kWh"),
      capacity = specifications.find((s) => s.name === "Nominal capacity")?.value;
    if (
      nominal &&
      capacity &&
      Math.abs(value * 1000 - nominal * capacity) > nominal * capacity * 0.025
    )
      throw new Error("Inconsistent nominal energy");
    specifications.push(
      spec(
        "Nominal energy",
        value,
        "kWh",
        "Published nominal energy of one battery, not usable energy or current state of charge.",
      ),
    );
  }
  for (const label of ["Charge Temperature Range", "Discharge Temperature Range"])
    if (get(label))
      specifications.push(
        spec(
          label,
          get(label),
          null,
          "Manufacturer operating-temperature range; current derating can also apply.",
        ),
      );
  const revisionText = nodes(document(html), (n) => n.tagName === "p")
    .map(text)
    .find((t) => /^Rev\.#/.test(t));
  return [
    makeRecord("Rolls", entry.model, "battery", specifications, entry, manifest, revision, {
      source: {
        revision: revisionText?.slice(0, 80) ?? `Snapshot ${manifest.checkedAt}`,
        section: "Battery specifications and capacity",
      },
    }),
  ];
}

export function victronRecords(html, entry, manifest, revision) {
  const result = [];
  for (const table of tables(html)) {
    const header = table[0];
    if (
      !header ||
      header.length < 2 ||
      !header.slice(1).every((s) => /^(?:MPPT )?\d+\/\d+$/.test(s))
    )
      continue;
    const get = (pattern, column) => {
      const rows = table.filter((r) => pattern.test(r[0]));
      if (rows.length !== 1 || rows[0].length !== header.length)
        throw new Error(`Missing/ambiguous Victron field: ${pattern}`);
      return rows[0][column];
    };
    const footer = table.at(-1)[0];
    if (!footer.includes("limit input power") || !footer.includes("short circuit current"))
      throw new Error("Unrecognized Victron table footnotes");
    for (let column = 1; column < header.length; column++) {
      const number = header[column].replace(/^MPPT /, "");
      const model = `${entry.family} ${number}${entry.variant ? ` ${entry.variant}` : ""}`;
      const restricted = /150\/(85|100)$/.test(number) && footer.includes("12/24V only");
      const supported = get(/^Battery voltage/i, column);
      const specifications = [
        spec(
          "Maximum charge current",
          numeric(get(/^Maximum battery current$/, column), "A"),
          "A",
          "Battery-side charging output; full rated output up to 40°C. Not PV input current.",
        ),
        spec(
          "Supported battery voltage",
          restricted ? "12/24V; 36/48V require exact part-number verification" : supported,
          null,
          restricted
            ? "Manual footnote 7 excludes specific 150/85 and 150/100 part numbers from 36/48V use."
            : "Technical-specification table. Auto/manual selection depends on model and chemistry.",
        ),
        spec(
          "Maximum PV short-circuit current",
          numeric(get(/^Max\. PV short circuit current$/, column), "A"),
          "A",
          "PV array input Isc limit; excess can cause damage with reverse polarity. Not battery charging current.",
        ),
      ];
      const rawVoc = get(/^(?:Maximum|Max\.) PV [Oo]pen circuit [Vv]oltage$/, column);
      const absolute = rawVoc.match(/^(\d+)\s*V(?: absolute maximum coldest conditions)?/);
      if (
        !absolute ||
        !/^(\d+)\s*V(?: absolute maximum coldest conditions\s*(\d+)\s*V start-up and operating maximum)?$/.test(
          rawVoc,
        )
      )
        throw new Error(`Unrecognized PV voltage limits: ${rawVoc}`);
      specifications.push(
        spec(
          "Maximum PV open-circuit voltage",
          Number(absolute[1]),
          "V",
          "Absolute maximum, including coldest conditions. Array Voc must remain below this; battery voltage is a separate value.",
        ),
      );
      const operating = rawVoc.match(/(\d+)\s*V start-up and operating maximum/);
      if (operating)
        specifications.push(
          spec(
            "Maximum PV operating voltage",
            Number(operating[1]),
            "V",
            "Start-up and operating maximum; distinct from absolute cold Voc maximum.",
          ),
        );
      for (const row of table.filter((r) => /^Nominal PV power, \d+V$/.test(r[0]))) {
        const voltage = Number(row[0].match(/(\d+)V/)[1]);
        if (row[column] === "-" || (restricted && voltage > 24)) continue;
        specifications.push(
          spec(
            `Nominal PV power at ${voltage} V`,
            numeric(row[column], "W"),
            "W",
            `At ${voltage} V battery voltage class. More PV power is limited; this is not an unrestricted array-size allowance. Voltage/current limits still apply.`,
          ),
        );
      }
      result.push(
        makeRecord(
          "Victron Energy",
          model,
          "charge-controller",
          specifications,
          entry,
          manifest,
          revision,
          {
            limitations: [
              "Nominal PV watts are a charging-output rating, not a hard PV input watt ceiling. Connector current limits and all table footnotes still apply.",
              ...(restricted
                ? [
                    "36/48V compatibility is withheld pending exact part number; manual footnote 7 identifies 12/24V-only variants.",
                  ]
                : []),
            ],
          },
        ),
      );
    }
  }
  if (!result.length) throw new Error("No recognized Victron MPPT tables");
  return result;
}

export function smartShuntRecords(html, entry, manifest, revision) {
  const table = tables(html).find((t) => t[0]?.[0] === "SmartShunt");
  const get = (name) => table?.find((row) => row[0] === name)?.[1];
  if (
    get("SmartShunt") !== "300 A / 500 A / 1000 A / 2000 A" ||
    get("VE.Direct communication port") !== "Yes" ||
    get("Supply voltage range") !== "6.5 - 70 VDC" ||
    get("Protection category") !== "IP21"
  )
    throw new Error("SmartShunt table changed; review required");
  return [300, 500, 1000, 2000].map((amps) =>
    makeRecord(
      "Victron Energy",
      `SmartShunt ${amps}A`,
      "battery-monitor",
      [
        spec(
          "Shunt current rating",
          amps,
          "A",
          "IP21 model rating. Select using maximum bank current including surges; not battery Ah.",
        ),
        spec(
          "Minimum supply voltage",
          6.5,
          "V",
          "Bank voltage must remain within the supply range; a 6 V nominal bank is not automatically suitable.",
        ),
        spec(
          "Maximum supply voltage",
          70,
          "V",
          "Maximum supply voltage; distinct from nominal battery voltage.",
        ),
        spec(
          "Current draw",
          get("Current draw"),
          null,
          "Manufacturer technical table; not total controller or adapter consumption.",
        ),
        spec(
          "Configurable battery capacity",
          get("Battery capacity (Ah)"),
          null,
          "User configuration range, not measured bank capacity or battery health.",
        ),
        spec(
          "Operating temperature range",
          get("Operating temperature range"),
          null,
          "Manufacturer operating range.",
        ),
        spec("Protection category", "IP21", null, "This record does not cover IP65 variants."),
      ],
      entry,
      manifest,
      revision,
    ),
  );
}
