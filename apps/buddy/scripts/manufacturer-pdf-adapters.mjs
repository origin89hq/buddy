import { makeRecord, numeric, spec } from "./manufacturer-adapters.mjs";

// Resolve values by PDF cell geometry, including merged cells. Never forward-fill
// a missing value merely because its neighbour has one.
export function pdfValue(table, header, label) {
  const rows = table.rows.filter((r) => r.some((c) => label.test(c.text)));
  if (rows.length !== 1) throw new Error(`Missing/ambiguous PDF row: ${label}`);
  const x = (header.bounds[0] + header.bounds[2]) / 2;
  const cells = rows[0].filter((c) => c.bounds[0] <= x && c.bounds[2] >= x && c.text);
  if (cells.length !== 1) throw new Error(`Missing/ambiguous PDF cell: ${header.text}, ${label}`);
  return cells[0].text;
}

export function inverterPdfRecords(tables, entry, manifest, revision) {
  const records = [];
  for (const table of tables) {
    if (!table.rows.some((r) => r.some((c) => c.text === "Continuous output power"))) continue;
    const models = table.rows[0]?.filter((c) => /^IP\d+-\d+(?:-Plus)?$/.test(c.text)) ?? [];
    for (const header of models) {
      const get = (pattern) => pdfValue(table, header, pattern);
      const watts = get(/^Continuous output power$/);
      const match = watts.match(/^(\d+)W(?:@35℃@(?:35℃@)?\s*Rated input voltage)?$/i);
      if (!match) throw new Error(`Unexpected continuous rating: ${watts}`);
      const input = numeric(get(/^Rated input voltage$/), "VDC");
      const specifications = [
        spec(
          "Continuous AC output power",
          Number(match[1]),
          "W",
          watts.includes("@")
            ? "At 35°C and rated DC input voltage, per manufacturer table."
            : "Continuous rating from manufacturer table, separate from 15-minute and surge power.",
        ),
        spec(
          "Rated DC input voltage",
          input,
          "V",
          "DC battery input variant, not AC output voltage.",
        ),
        spec(
          "AC output voltage",
          get(/^Output voltage$/),
          null,
          "AC output variant and tolerances from manufacturer. Do not transfer to other suffixes.",
        ),
        spec(
          "DC input voltage range",
          get(/^Input voltage range$/),
          null,
          "Published operating input range; not a battery charging setting.",
        ),
        spec(
          "AC output frequency",
          get(/^Output frequency$/),
          null,
          "Manufacturer output frequency and tolerance.",
        ),
      ];
      const surge = get(/^Surge power$/).match(/^(\d+)W(?:@(\d+)S)?$/i);
      if (!surge) throw new Error("Unknown surge rating format");
      if (Number(surge[1]) < Number(match[1])) throw new Error("Surge below continuous power");
      specifications.push(
        spec(
          "Surge AC output power",
          Number(surge[1]),
          "W",
          surge[2]
            ? `For ${surge[2]} seconds only. Not continuous output.`
            : "Surge only; duration not specified in this table.",
        ),
      );
      const durationRow = table.rows.some((r) => r.some((c) => c.text === "Output power 15 min."));
      if (durationRow)
        specifications.push(
          spec(
            "15-minute AC output power",
            numeric(get(/^Output power 15 min\.$/), "W"),
            "W",
            "For 15 minutes, not continuous power.",
          ),
        );
      // Some manuals split no-load ratings onto the next physical page. Leave these unknown.
      if (table.rows.some((r) => r.some((c) => c.text === "No-load current")))
        specifications.push(
          spec(
            "No-load DC current",
            get(/^No-load current$/),
            null,
            "Manufacturer no-load input current; inequality is preserved.",
          ),
        );
      records.push(
        makeRecord("EPEVER", header.text, "inverter", specifications, entry, manifest, revision, {
          source: {
            page: table.page,
            section: undefined,
            revision:
              entry.family === "IPower Plus" ? "Manual V3.3" : `Snapshot ${manifest.checkedAt}`,
          },
        }),
      );
    }
  }
  if (!records.length) throw new Error("No recognized EPEVER inverter specification tables");
  return records;
}

export function mpptPdfRecords(tables, entry, manifest, revision) {
  const records = [];
  for (const table of tables) {
    if (
      !table.rows.some((r) =>
        r.some((c) => /^(?:BATT1 )?Rated charg(?:e|ing) current$/i.test(c.text)),
      )
    )
      continue;
    let headers;
    if (entry.family === "XTRA N")
      headers = (table.rows[1] ?? [])
        .filter((c) => /^\d{4}N$/.test(c.text))
        .map((c) => ({ ...c, text: `XTRA${c.text}` }));
    else
      headers = (table.rows[0] ?? []).filter((c) =>
        /^(Tracer\d+AN|DR\d+N|XTRA\d+N G3)/.test(c.text),
      );
    for (const header of headers) {
      const get = (pattern) => pdfValue(table, header, pattern);
      let models = [header.text];
      if (entry.family === "DuoRacer") models = [`${header.text}-DDB`, `${header.text}-DDS`];
      if (entry.family === "XTRA N G3") {
        const base = header.text.match(/^(XTRA\d+N) G3\/G3 BLE$/)?.[1];
        if (!base) throw new Error(`Unrecognized G3 variants: ${header.text}`);
        models = [`${base} G3`, `${base} G3 BLE`];
      }
      const current = numeric(get(/^(?:BATT1 )?Rated charg(?:e|ing) current$/i), "A");
      const supportedRaw = get(
        /^(?:System (?:nominal|rated) voltage|BATT1 rated voltage|Battery Rated Voltage)[★①]?$/i,
      );
      const supported = supportedRaw.replace(/[★①]/g, "");
      const rawVoc = get(/^Max\.? PV [Oo]pen[- ]?[Cc]ircuit [Vv]oltage$/);
      let voc = rawVoc.match(/^(\d+)V②\s*(\d+)V③$/);
      if (!voc)
        voc = rawVoc.match(/^(\d+)V\(at the lowest temperature\)\s*(\d+)V\((?:at )?25℃\)$/i);
      if (!voc) throw new Error(`Unknown PV voltage conditions: ${rawVoc}`);
      const powers = get(/^Rated charg(?:e|ing) power$/i);
      const pairs = [...powers.matchAll(/([\d,]+)W\/(\d+)V/g)];
      if (!pairs.length || powers.replace(/[\d,W/V\s]/g, ""))
        throw new Error(`Unrecognized rated power: ${powers}`);
      const specs = [
        spec(
          "Maximum charge current",
          current,
          "A",
          entry.family === "DuoRacer"
            ? "BATT1 charging output, not PV input current. BATT2 is a separate output."
            : "Rated battery-side charging current, not PV input current.",
        ),
        spec(
          "Supported battery voltage",
          header.text === "Tracer6210AN"
            ? "12/24V; higher voltages withheld due to conflicting table"
            : supported,
          null,
          header.text === "Tracer6210AN"
            ? "Table lists 36/48V but operating range is 8–32V and rated power is only specified at 12/24V; verify manufacturer documentation."
            : "Manufacturer voltage classes. Auto-detection restrictions depend on battery chemistry.",
        ),
        spec(
          "Maximum PV open-circuit voltage",
          Number(voc[1]),
          "V",
          "At minimum operating environmental temperature, per table footnotes. Array cold Voc must stay below this limit.",
        ),
        spec(
          "Maximum PV open-circuit voltage at 25°C",
          Number(voc[2]),
          "V",
          "At 25°C environmental temperature; distinct from the absolute cold-temperature limit.",
        ),
        ...pairs.map((p) =>
          spec(
            `Nominal PV power at ${p[2]} V`,
            Number(p[1].replaceAll(",", "")),
            "W",
            `Rated charging power at ${p[2]} V bank voltage class. This is not by itself the maximum permitted connected PV array power.`,
          ),
        ),
      ];
      if (entry.family === "DuoRacer")
        specs.push(
          spec(
            "BATT2 maximum charge current",
            numeric(get(/^BATT2 Rated Charge Current$/i), "A"),
            "A",
            "Separate starter-battery charging output, not additive to BATT1 or a PV input rating.",
          ),
        );
      for (const model of models)
        records.push(
          makeRecord("EPEVER", model, "charge-controller", specs, entry, manifest, revision, {
            source: { section: undefined, page: table.page, revision: `Manual ${entry.revision}` },
            limitations: [
              "PV voltage, PV current and connected array-power constraints are separate. Never treat charge-current limiting as protection from excessive PV voltage.",
            ],
          }),
        );
    }
  }
  if (!records.length) throw new Error("No recognized EPEVER MPPT specification tables");
  return records;
}
