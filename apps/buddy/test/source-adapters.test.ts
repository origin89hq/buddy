import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { records as discover } from "../scripts/adapters/discover.mjs";
import { records as duromax } from "../scripts/adapters/duromax.mjs";
import { adapters } from "../scripts/adapters/index.mjs";
import { records as morningstar } from "../scripts/adapters/morningstar.mjs";
import { records as usBattery } from "../scripts/adapters/us-battery.mjs";
import { records as yilink } from "../scripts/adapters/yilink.mjs";
import { tables } from "../scripts/catalogue-html.mjs";
import { integrationFor, loadIntegrationProfiles } from "../scripts/integration-profiles.mjs";
import { numeric } from "../scripts/manufacturer-adapters.mjs";
import type { KnowledgeRecord } from "../src/knowledge.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/manufacturers/${name}`, import.meta.url), "utf8");
const manifest = { checkedAt: "2026-09-08" },
  revision = "a".repeat(64);
const source = { url: "https://example.com/page", sha256: revision };
const value = (record: KnowledgeRecord, name: string) =>
  record.specifications.find((s: KnowledgeRecord["specifications"][number]) => s.name === name);

test("every adapter in the registry can turn a source into records", () => {
  for (const [name, adapter] of Object.entries(adapters))
    assert.equal(typeof adapter.records, "function", name);
});
test("a thousands separator is not a decimal point", () => {
  assert.equal(numeric("1,000W", "W"), 1000);
  assert.equal(numeric("8,000 W", "W"), 8000);
  assert.throws(() => numeric("1,0W", "W"));
});
test("a percentage colspan is one column, as a browser renders it, and an absurd span is still refused", () => {
  assert.deepEqual(
    tables(
      '<table><tr><td colspan="100%">a</td></tr><tr><td>b</td><td colspan="50%">c</td></tr></table>',
    )[0],
    [["a"], ["b", "c"]],
  );
  assert.throws(
    () => tables('<table><tr><td colspan="500">a</td></tr></table>'),
    /Invalid table span/,
  );
});

test("U.S. Battery C20 and reserve minutes come from the page's own column and the voltage from its listing", async () => {
  const [record] = usBattery(
    fixture("us-battery-2200.html"),
    { ...source, voltageClasses: [6] },
    manifest,
    revision,
  );
  assert.equal(record.model, "US 2200 XC2");
  assert.equal(value(record, "Nominal voltage").value, 6);
  assert.equal(value(record, "Capacity C20").value, 232);
  assert.equal(value(record, "Discharge time at 75 A").value, 122);
  assert.equal(value(record, "Discharge time at 25 A").value, 474);
  assert.match(record.limitations.join(" "), /data_sheet.*\.pdf/);
  const profiles = await loadIntegrationProfiles();
  assert.equal(integrationFor(record, profiles).integration.status, "passive");
});
test("a model listed under two voltage classes, absent from its table, or with impossible reserve minutes is refused", () => {
  const html = fixture("us-battery-2200.html");
  assert.throws(
    () => usBattery(html, { ...source, voltageClasses: [6, 12] }, manifest, revision),
    /refusing to guess/,
  );
  assert.throws(
    () =>
      usBattery(
        html
          .replace("<h1>US 2200 XC2</h1>", "<h1>US 9999 XC2</h1>")
          .replace(/<h1[^>]*>US 2200 XC2<\/h1>/, "<h1>US 9999 XC2</h1>"),
        { ...source, voltageClasses: [6] },
        manifest,
        revision,
      ),
    /absent|heading/,
  );
  // 474 minutes at 75 A would be 592 Ah from a 232 Ah battery.
  assert.throws(
    () =>
      usBattery(
        html.replace(">122<", ">474<"),
        { ...source, voltageClasses: [6] },
        manifest,
        revision,
      ),
    /Inconsistent reserve/,
  );
});

test("Morningstar TriStar MPPT keeps charge amps, cold Voc and per-voltage nominal power apart", () => {
  const records = morningstar(
    fixture("morningstar-tristar-mppt.html"),
    { ...source, family: "tristar-mppt" },
    manifest,
    revision,
  );
  assert.deepEqual(
    records.map((r: KnowledgeRecord) => r.model),
    ["TS-MPPT-30", "TS-MPPT-45", "TS-MPPT-60", "TS-MPPT-60M"],
  );
  const r = records[0];
  assert.equal(value(r, "Maximum charge current").value, 30);
  assert.equal(value(r, "Maximum PV open-circuit voltage").value, 150);
  assert.equal(value(r, "Nominal PV power at 12 V").value, 400);
  assert.equal(value(r, "Nominal PV power at 48 V").value, 1600);
  assert.equal(r.kind, "charge-controller");
});
test("a model row made of images is not a model, and power that contradicts the charge rating is refused", () => {
  assert.throws(
    () =>
      morningstar(
        fixture("morningstar-genstar.html"),
        { ...source, family: "genstar-mppt" },
        manifest,
        revision,
      ),
    /not model text/,
  );
  const html = fixture("morningstar-tristar-mppt.html");
  assert.throws(
    () =>
      morningstar(
        html.replace("400W", "900W"),
        { ...source, family: "tristar-mppt" },
        manifest,
        revision,
      ),
    /disagree/,
  );
  assert.throws(
    () =>
      morningstar(
        html.replace("800W</td>", "700W</td>"),
        { ...source, family: "tristar-mppt" },
        manifest,
        revision,
      ),
    /scale with voltage/,
  );
});

test("Yilink W48200 is 48 V nominal, 200 Ah, 9.6 kWh with CAN/RS485 named as ports, not as support", () => {
  const [record] = yilink(
    fixture("yilink-w48200.html"),
    { ...source, family: "LiFePO4 battery" },
    manifest,
    revision,
  );
  assert.equal(record.model, "YL-W48200");
  assert.deepEqual(
    record.aliases.map((a: KnowledgeRecord["aliases"][number]) => a.model),
    ["W48200"],
  );
  assert.equal(value(record, "Nominal voltage").value, 48);
  assert.equal(value(record, "Nominal capacity").value, 200);
  assert.equal(value(record, "Nominal energy").value, 9.6);
  assert.equal(value(record, "Maximum continuous discharge current").value, 100);
  assert.match(
    value(record, "Communication interfaces").conditions,
    /not a verified Origin89 driver/,
  );
  assert.equal(record.integration, undefined);
});
test("a Yilink family page with several capacities is not a product, and energy must agree with volts × Ah", () => {
  assert.throws(
    () => yilink(fixture("yilink-lfp-abs.html"), { ...source }, manifest, revision),
    /one model label/,
  );
  assert.throws(
    () =>
      yilink(
        fixture("yilink-w48200.html").replace("9.6 kWh", "19.6 kWh"),
        { ...source },
        manifest,
        revision,
      ),
    /disagrees/,
  );
});

test("a DuroMax feed page publishes the generator with a Part # and quarantines the one without, per product", () => {
  const result = duromax(
    fixture("duromax-feed.json"),
    { ...source, format: "json", page: 1 },
    manifest,
    revision,
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].model, "XP13500iH");
  const r = result.records[0];
  assert.equal(r.brand, "DuroStar");
  assert.equal(r.model, "DS8000iX");
  assert.equal(r.kind, "generator");
  assert.equal(value(r, "Continuous AC output power (gasoline)").value, 6500);
  assert.equal(value(r, "Peak AC output power (propane)").value, 7600);
  const propaneRun = r.specifications.find((s: KnowledgeRecord["specifications"][number]) =>
    s.name.startsWith("Run time at 25 % load (propane)"),
  );
  assert.equal(propaneRun.value, 17);
  assert.match(propaneRun.name, /40 lbs\. Tank/);
  assert.match(value(r, "Remote start").conditions, /not a documented two-wire start/);
});
test("a generator whose running watts meet its peak watts is quarantined rather than published", () => {
  const broken = fixture("duromax-feed.json").replace("<td>6,500 W</td>", "<td>8,000 W</td>");
  const result = duromax(broken, { ...source, format: "json", page: 1 }, manifest, revision);
  assert.equal(result.records.length, 0);
  assert.match(
    result.rejected.map((r: { reason: string }) => r.reason).join(" "),
    /not below peak/,
  );
});

test("Discover 42-48-6650 keeps 1C Ah, nominal kWh and usable DoD distinct and reads the same value from every tab", () => {
  const [record] = discover(
    fixture("discover-42-48-6650.html"),
    { ...source, family: "battery" },
    manifest,
    revision,
  );
  assert.equal(record.model, "42-48-6650");
  assert.equal(value(record, "Chemistry").value, "LiFePO4");
  assert.equal(value(record, "Capacity C1").value, 130);
  assert.equal(value(record, "Nominal energy").value, 7.39);
  assert.equal(value(record, "Usable depth of discharge").value, "90%");
  assert.equal(value(record, "Maximum peak current").value, 300);
  assert.equal(value(record, "Discharge time at 100 A").value, 78);
  assert.equal(value(record, "Nominal voltage"), undefined);
});
test("Discover tabs that disagree, or a peak current below continuous, refuse the page", () => {
  const html = fixture("discover-42-48-6650.html");
  assert.throws(
    () => discover(html.replace(">7.39<", ">7.93<"), { ...source }, manifest, revision),
    /Tabs disagree/,
  );
  assert.throws(
    () => discover(html.replaceAll(">300<", ">30<"), { ...source }, manifest, revision),
    /Peak current below/,
  );
});
