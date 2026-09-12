import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rollsRecords, victronRecords } from "../scripts/manufacturer-adapters.mjs";
import { inverterPdfRecords, mpptPdfRecords } from "../scripts/manufacturer-pdf-adapters.mjs";
import type { KnowledgeRecord } from "../src/knowledge.ts";
import { citedSources, identityKey } from "../src/knowledge.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/manufacturers/${name}`, import.meta.url), "utf8");
const manifest = { checkedAt: "2026-09-08" },
  revision = "a".repeat(64);
const source = { url: "https://example.com/manual", sha256: revision };
const value = (record: KnowledgeRecord, name: string) =>
  record.specifications.find((s: KnowledgeRecord["specifications"][number]) => s.name === name);
test("Rolls flooded battery keeps C20/C100, test amps and individual nominal voltage distinct", () => {
  const [record] = rollsRecords(
    fixture("rolls-s6.html"),
    { ...source, model: "S6 L16-HC" },
    manifest,
    revision,
  );
  assert.equal(value(record, "Chemistry").value, "Flooded lead-acid");
  assert.equal(value(record, "Nominal voltage").value, 6);
  assert.equal(value(record, "Capacity C20").value, 445);
  assert.equal(value(record, "Capacity C100").value, 512);
  assert.match(value(record, "Capacity C20").conditions, /20-hour discharge at 22.25 A/);
  assert.match(value(record, "Capacity C20").conditions, /not a maximum discharge/);
  assert.equal(value(record, "Maximum charge current").value, 85);
  assert.notEqual(identityKey(record.brand, record.model), identityKey("Rolls", "S-550"));
});
test("36 V lithium class does not overwrite actual 38.4 V nominal voltage or temperature-dependent amps", () => {
  const [record] = rollsRecords(
    fixture("rolls-r36.html"),
    { ...source, model: "R36-100LFP" },
    manifest,
    revision,
  );
  assert.equal(value(record, "Voltage class").value, 36);
  assert.equal(value(record, "Nominal voltage").value, 38.4);
  assert.equal(value(record, "Nominal capacity").value, 100);
  assert.equal(value(record, "Nominal energy").value, 3.84);
  assert.equal(value(record, "Maximum continuous discharge current").value, 100);
  assert.deepEqual(
    record.specifications
      .filter((s: KnowledgeRecord["specifications"][number]) =>
        s.name.startsWith("Recommended charge current ("),
      )
      .map((s: KnowledgeRecord["specifications"][number]) => s.value),
    [20, 50, 20],
  );
  const cited = citedSources({ status: "available", records: [record], truncated: false }, [
    record.id,
  ]);
  assert.equal(cited[0].section, "Battery specifications and capacity");
  assert.equal(cited[0].page, undefined);
});
test("identity changes and inconsistent battery tables are rejected, not repaired by model naming", () => {
  assert.throws(
    () => rollsRecords(fixture("rolls-s6.html"), { ...source, model: "S-550" }, manifest, revision),
    /Model differs/,
  );
  assert.throws(
    () =>
      rollsRecords(
        fixture("rolls-s6.html").replace("445&nbsp;", "945&nbsp;"),
        { ...source, model: "S6 L16-HC" },
        manifest,
        revision,
      ),
    /Inconsistent capacity/,
  );
});
test("Victron merged cells retain input/output amps, cold/operating voltage limits and restricted variants", () => {
  const records = victronRecords(
    fixture("victron.html"),
    { ...source, family: "SmartSolar MPPT", variant: "VE.Can" },
    manifest,
    revision,
  );
  const record = records.find((r: KnowledgeRecord) => r.model === "SmartSolar MPPT 250/70 VE.Can");
  assert.equal(value(record, "Maximum charge current").value, 70);
  assert.equal(value(record, "Maximum PV short-circuit current").value, 35);
  assert.equal(value(record, "Maximum PV open-circuit voltage").value, 250);
  assert.equal(value(record, "Maximum PV operating voltage").value, 245);
  const restricted = records.find(
    (r: KnowledgeRecord) => r.model === "SmartSolar MPPT 150/85 VE.Can",
  );
  assert.equal(value(restricted, "Nominal PV power at 48 V"), undefined);
  assert.match(value(restricted, "Supported battery voltage").conditions, /footnote 7/);
});
test("EPEVER inverter merged power cells preserve separate 12/24/48 V variants and physical PDF page", () => {
  const records = inverterPdfRecords(
    JSON.parse(fixture("ipower-plus.json")),
    { ...source, family: "IPower Plus" },
    manifest,
    revision,
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => r.model),
    ["IP2000-11-Plus", "IP2000-21-Plus", "IP2000-41-Plus"],
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => value(r, "Rated DC input voltage").value),
    [12, 24, 48],
  );
  for (const r of records) {
    assert.equal(value(r, "Continuous AC output power").value, 2000);
    assert.match(value(r, "Continuous AC output power").conditions, /35°C/);
    assert.match(value(r, "Surge AC output power").conditions, /5 seconds/);
    assert.equal(r.source.page, 42);
  }
});
test("XTRA4210N is 40 A battery output and 100 V cold PV maximum, not a 100 A controller", () => {
  const records = mpptPdfRecords(
    JSON.parse(fixture("xtra.json")),
    { ...source, family: "XTRA N", revision: "V4.5 ETL" },
    manifest,
    revision,
  );
  assert.equal(records.length, 10);
  const r = records.find((r: KnowledgeRecord) => r.model === "XTRA4210N");
  assert.equal(value(r, "Maximum charge current").value, 40);
  assert.equal(value(r, "Maximum PV open-circuit voltage").value, 100);
  assert.equal(value(r, "Maximum PV open-circuit voltage at 25°C").value, 92);
  assert.equal(value(r, "Nominal PV power at 12 V").value, 520);
  assert.equal(value(r, "Nominal PV power at 48 V"), undefined);
  assert.equal(r.source.page, 44);
});
test("DuoRacer primary and starter-battery charging outputs remain separate", () => {
  const records = mpptPdfRecords(
    JSON.parse(fixture("duoracer.json")),
    { ...source, family: "DuoRacer", revision: "V2.5" },
    manifest,
    revision,
  );
  assert.equal(records.length, 16);
  const r = records.find((r: KnowledgeRecord) => r.model === "DR3210N-DDS");
  assert.equal(value(r, "Maximum charge current").value, 30);
  assert.equal(value(r, "BATT2 maximum charge current").value, 1);
});
