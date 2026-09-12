import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCecBatteries } from "../scripts/cec-batteries.mjs";
import { citedSources, knowledgeRecordSchema } from "../src/knowledge.ts";

const fixture = JSON.parse(
  readFileSync(new URL("fixtures/cec-batteries/rows.json", import.meta.url), "utf8"),
);
const source = JSON.parse(
  readFileSync(new URL("../knowledge/cec-batteries-source.json", import.meta.url), "utf8"),
);
const manifest = { ...source, expectedRows: 3 },
  revision = "a".repeat(64);
test("CEC preserves kWh and kW without manufacturing Ah, volts, amps or controller support", () => {
  const parsed = parseCecBatteries(fixture, manifest, revision);
  assert.equal(parsed.records.length, 3);
  assert.deepEqual(parsed.rejected, []);
  const record = parsed.records[0];
  assert.equal(record.specifications.find((s: { unit: string }) => s.unit === "kWh").value, 8.2);
  assert.equal(record.specifications.find((s: { unit: string }) => s.unit === "kW").value, 9.8);
  assert.ok(
    !record.specifications.some((s: { unit: string }) => ["Ah", "A", "V"].includes(s.unit)),
  );
  assert.equal(record.integration, undefined);
  assert.equal(
    citedSources({ status: "available", records: [record], truncated: false }, [record.id])[0].row,
    13,
  );
});
test("a standard named UL does not become UL-issued or directly verified certification", () => {
  const record = parseCecBatteries(fixture, manifest, revision).records[2];
  assert.equal(record.certifications[0].standard, "UL 1973");
  assert.equal(record.certifications[0].certifyingBody, "CSA");
  assert.equal(record.certifications[0].evidence, "catalogue-reported");
  assert.match(record.limitations.join(" "), /Canadian certification scope is not supplied/);
  assert.throws(() =>
    knowledgeRecordSchema.parse({
      ...record,
      certifications: [{ ...record.certifications[0], evidence: "directory-verified" }],
    }),
  );
});
test("blank discharge power stays absent and nonpositive or malformed values are quarantined", () => {
  const missing = structuredClone(fixture);
  missing.rows[12][9] = null;
  const record = parseCecBatteries(missing, manifest, revision).records[0];
  assert.ok(!record.specifications.some((s: { unit: string }) => s.unit === "kW"));
  assert.match(record.limitations.join(" "), /not supplied/);
  for (const value of [0, -1, "9.8", "=1+1"]) {
    const broken = structuredClone(fixture);
    broken.rows[12][9] = value;
    assert.equal(parseCecBatteries(broken, manifest, revision).rejected.length, 1);
  }
});
test("changed worksheet, units, row count or source revision abort the adapter", () => {
  for (const mutate of [
    (input: typeof fixture) => {
      input.sheet = "Other";
    },
    (input: typeof fixture) => {
      input.rows[11][8] = "(Wh)";
    },
    (input: typeof fixture) => {
      input.rows.push(input.rows[12]);
    },
    (input: typeof fixture) => {
      input.rows[1][0] = "Unknown revision";
    },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => parseCecBatteries(changed, manifest, revision));
  }
});
