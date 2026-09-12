import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { records as outback } from "../scripts/adapters/outback.mjs";
import { cells, columnGrid, groups } from "../scripts/adapters/pdf-text.mjs";
import { records as samlex } from "../scripts/adapters/samlex.mjs";
import { records as schneider } from "../scripts/adapters/schneider.mjs";
import { records as solark } from "../scripts/adapters/solark.mjs";
import { records as volthium } from "../scripts/adapters/volthium.mjs";
import type { KnowledgeRecord } from "../src/knowledge.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/manufacturers/${name}`, import.meta.url), "utf8"));
const manifest = { checkedAt: "2026-09-08" },
  revision = "a".repeat(64);
const source = { url: "https://example.com/sheet.pdf", sha256: revision };
const value = (record: KnowledgeRecord, name: string) =>
  record.specifications.find((s: KnowledgeRecord["specifications"][number]) => s.name === name);
const mutate = (pages: unknown, from: string, to: string) =>
  JSON.parse(JSON.stringify(pages).replaceAll(from, to));

test("a cell centred on the model area is a merged rating; a cell over one column is that column's alone", () => {
  const grid = columnGrid([
    { text: "A", x0: 100, x1: 120 },
    { text: "B", x0: 200, x1: 220 },
    { text: "C", x0: 300, x1: 320 },
  ]);
  const merged = cells(
    {
      words: [
        { text: "Label", x0: 10, x1: 40 },
        { text: "2000", x0: 195, x1: 215 },
        { text: "Watts", x0: 218, x1: 240 },
      ],
    },
    grid,
  );
  assert.deepEqual(merged.values, ["2000 Watts", "2000 Watts", "2000 Watts"]);
  const single = cells(
    {
      words: [
        { text: "Label", x0: 10, x1: 40 },
        { text: "12", x0: 105, x1: 115 },
        { text: "24", x0: 205, x1: 215 },
        { text: "48", x0: 305, x1: 315 },
      ],
    },
    grid,
  );
  assert.deepEqual(single.values, ["12", "24", "48"]);
  assert.equal(
    groups([
      { text: "a", x0: 0, x1: 10 },
      { text: "b", x0: 12, x1: 20 },
      { text: "c", x0: 60, x1: 70 },
    ]).length,
    2,
  );
});

test("Volthium identity comes from the store product and the sheet must agree on volts and Ah", () => {
  const entry = {
    ...source,
    model: "12V 100Ah GR24",
    sku: "12.8-100-G24Y-BT",
    productUrl: "https://volthium.com/fr/produit/batterie-12v-100ah-gr24/",
    matchedBy: "store-link",
  };
  const [record] = volthium(fixture("volthium-12v-100ah-gr24.json"), entry, manifest, revision);
  assert.equal(record.model, "12V 100Ah GR24");
  assert.deepEqual(record.aliases, [{ brand: "Volthium", model: "12.8-100-G24Y-BT" }]);
  assert.equal(value(record, "Nominal voltage").value, 12.8);
  assert.equal(value(record, "Nominal capacity").value, 100);
  assert.equal(value(record, "Nominal energy").value, 1280);
  assert.equal(value(record, "Maximum continuous discharge current").value, 100);
  assert.equal(value(record, "Discharge time at 20 A").value, 300);
  assert.equal(record.source.page, 2);
  assert.throws(
    () =>
      volthium(
        fixture("volthium-12v-100ah-gr24.json"),
        { ...entry, model: "12V 200Ah GR24" },
        manifest,
        revision,
      ),
    /does not match the sheet/,
  );
  assert.throws(
    () =>
      volthium(
        fixture("volthium-12v-100ah-gr24.json"),
        { ...source, unmatched: "0 linked, 2 by name" },
        manifest,
        revision,
      ),
    /No single store product/,
  );
});
test("a 2024 two-column Volthium sheet reads the same rows, and a range stays a range", () => {
  const entry = {
    ...source,
    model: "12V 200Ah autochauffante",
    sku: "12.8-200-G4DY-CH2OSS",
    productUrl: "https://volthium.com/x",
    matchedBy: "voltage-capacity-name",
  };
  const [record] = volthium(fixture("volthium-12v-200ah-2024.json"), entry, manifest, revision);
  assert.equal(value(record, "Nominal capacity").value, 200);
  assert.equal(value(record, "Recommended charge current").value, "5 A - 80 A");
  assert.equal(record.source.page, 2);
  assert.throws(
    () =>
      volthium(
        mutate(fixture("volthium-12v-200ah-2024.json"), '"2560"', '"3560"'),
        entry,
        manifest,
        revision,
      ),
    /disagrees/,
  );
});

test("Sol-Ark reads the first rating column of a two-column sheet even when the legend garbles the header", () => {
  const [record] = solark(
    fixture("solark-15k.json"),
    { ...source, model: "15K-2P-LV" },
    manifest,
    revision,
  );
  assert.equal(record.model, "15K-2P-LV");
  assert.equal(value(record, "Continuous AC output power").value, 12000);
  assert.equal(value(record, "Surge AC output power").value, 24000);
  assert.equal(value(record, "Grid-tied real power").value, 15000);
  assert.equal(value(record, "Maximum battery charge current").value, 275);
  assert.equal(value(record, "Maximum PV input voltage").value, 500);
  assert.match(
    value(record, "Automatic generator start").conditions,
    /not a verified Origin89 integration/,
  );
  assert.throws(
    () => solark(fixture("solark-15k.json"), { ...source, model: "15K-2P" }, manifest, revision),
    /Sheet is for 15K-2P-LV/,
  );
  assert.throws(
    () =>
      solark(
        mutate(fixture("solark-15k.json"), '"24,000"', '"2,400"'),
        { ...source, model: "15K-2P-LV" },
        manifest,
        revision,
      ),
    /Surge below continuous/,
  );
});

test("Samlex splits one sheet into the 12, 24 and 48 V models with shared and per-model cells kept apart", () => {
  const records = samlex(
    fixture("samlex-pst-2000.json"),
    { ...source, family: "dc-ac-power-inverters" },
    manifest,
    revision,
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => r.model),
    ["PST-2000-12", "PST-2000-24", "PST-2000-48"],
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => value(r, "Continuous AC output power").value),
    [2000, 2000, 2000],
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => value(r, "Nominal DC input voltage").value),
    [12, 24, 48],
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => value(r, "Maximum DC input current").value),
    ["240 A", "120 A", "60 A"],
  );
  assert.equal(records[0].kind, "inverter");
  assert.throws(
    () =>
      samlex(
        mutate(fixture("samlex-pst-2000.json"), "MODEL", "MODELS"),
        { ...source, family: "dc-ac-power-inverters" },
        manifest,
        revision,
      ),
    /No MODEL NO/,
  );
});

test("OutBack FXR models keep VA, charger amps and the DC voltage their suffix promises", () => {
  const records = outback(
    fixture("outback-fxr-a.json"),
    { ...source, family: "FXR/VFXR A series" },
    manifest,
    revision,
  );
  assert.equal(records.length, 6);
  const r = records.find((x: KnowledgeRecord) => x.model === "VFXR3524A");
  assert.equal(value(r, "Continuous AC output power").value, 3500);
  assert.equal(value(r, "Continuous AC output power").unit, "VA");
  assert.equal(value(r, "Nominal DC input voltage").value, 24);
  assert.equal(value(r, "Maximum battery charge current").value, 82);
  assert.throws(
    () =>
      outback(
        mutate(fixture("outback-fxr-a.json"), "VFXR3524A", "VFXR3548A"),
        { ...source },
        manifest,
        revision,
      ),
    /suffix and DC voltage disagree/,
  );
});

test("Schneider XW Pro keeps the split-phase and 120 V configurations of one part number apart", () => {
  const [record] = schneider(
    fixture("schneider-xw-pro.json"),
    { ...source, family: "Conext XW Pro" },
    manifest,
    revision,
  );
  assert.equal(record.model, "Conext XW Pro 6848 NA");
  assert.deepEqual(
    record.aliases.map((a: KnowledgeRecord["aliases"][number]) => a.model),
    ["865-6848-21", "XW Pro 6848 NA"],
  );
  assert.equal(value(record, "Continuous AC output power").value, 6800);
  assert.equal(value(record, "Continuous AC output power (120 V configuration)").value, 5760);
  assert.equal(value(record, "60-second overload power").value, 12000);
  assert.equal(value(record, "Maximum battery charge current").value, 140);
  assert.equal(value(record, "Maximum battery charge current (120 V configuration)").value, 120);
  assert.throws(
    () =>
      schneider(
        mutate(fixture("schneider-xw-pro.json"), '"W/12000"', '"W/1200"'),
        { ...source },
        manifest,
        revision,
      ),
    /below continuous/,
  );
});
