import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { integrationFor, loadIntegrationProfiles } from "../scripts/integration-profiles.mjs";
import { integrationSchema } from "../src/knowledge.ts";

const profiles = await loadIntegrationProfiles();
const seed = JSON.parse(
  readFileSync(new URL("../knowledge/reviewed.jsonl", import.meta.url), "utf8"),
);
test("passive lead-acid has no port and distinguishes bank monitoring from directional PZEM metering", () => {
  const passive = profiles["passive-lead-acid"];
  assert.equal(passive.status, "passive");
  assert.deepEqual(passive.ports, []);
  assert.deepEqual(passive.implementedMetrics, []);
  assert.match(
    passive.monitoringOptions.find((o: { model: string }) => o.model === "PZEM-017").limitations,
    /Not a bidirectional/,
  );
  assert.throws(() => integrationSchema.parse({ ...passive, driver: "invented-driver" }));
});
test("PZEM decoder exposes only its implemented V/A/W; SmartShunt remains a candidate integration", () => {
  const pzem = profiles["pzem-017"],
    shunt = profiles.smartshunt;
  assert.equal(pzem.status, "decoder-implemented");
  assert.deepEqual(pzem.implementedMetrics, ["DC voltage", "DC current", "DC power"]);
  assert.ok(!pzem.availableMetrics.some((m: { name: string }) => m.name === "State of charge"));
  assert.match(pzem.availableMetrics[1].conditions, /Unsigned/);
  assert.equal(shunt.status, "documented");
  assert.equal(shunt.driver, null);
  assert.deepEqual(shunt.implementedMetrics, []);
  assert.equal(
    shunt.availableMetrics.find((m: { name: string }) => m.name === "State of charge").nature,
    "estimated",
  );
  assert.match(shunt.limitations.join(" "), /300 A.*PID/);
});
test("integration matching does not transfer RS485 or a driver to smaller or unknown inverter variants", () => {
  const inverter = {
    ...seed,
    integration: undefined,
    brand: "EPEVER",
    kind: "inverter",
    aliases: [],
  };
  for (const model of ["IP350-12", "IP500-12", "IP2000-12-Plus-X"])
    assert.equal(integrationFor({ ...inverter, model }, profiles).integration, undefined);
  assert.equal(
    integrationFor({ ...inverter, model: "IP2000-11-Plus" }, profiles).integration.status,
    "documented",
  );
  assert.equal(
    integrationFor({ ...inverter, model: "XTRA4210N G3", kind: "charge-controller" }, profiles)
      .integration,
    undefined,
  );
});
