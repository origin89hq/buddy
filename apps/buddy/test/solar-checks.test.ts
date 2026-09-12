import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Equipment,
  mergeExtraction,
  newInstallation,
  questions,
  type SolarArray,
  solarArraySchema,
} from "@origin89/buddy";
import type { KnowledgeContext } from "../src/knowledge.ts";
import { solarChecks } from "../src/solar-checks.ts";

const array = (patch: Partial<SolarArray> = {}): SolarArray => ({
  name: "Roof",
  controllerRef: null,
  panelCount: 6,
  panelWatts: 500,
  bankVoltage: 12,
  chargeCurrentAmps: 60,
  panelsInSeries: null,
  parallelStrings: null,
  panelVoc: null,
  panelIsc: null,
  vocTemperatureCoefficient: null,
  minimumTemperature: null,
  evidence: "User reported",
  messageIds: ["m1"],
  ...patch,
});
const controller = (id: string, model = "MPPT60"): Equipment => ({
  id,
  existingId: null,
  additionalUnit: false,
  kind: "charge-controller",
  name: id,
  brand: "Maker",
  model,
  quantity: 1,
  evidence: "Label",
  photoIndexes: [],
  photoIds: [],
  messageIds: ["m1"],
  confirmed: true,
});
const none: KnowledgeContext = { status: "no-match", records: [], truncated: false };
const text = (checks: ReturnType<typeof solarChecks>) =>
  checks.flatMap((c) => c.findings.map((f) => f.text)).join(" ");
const known: KnowledgeContext = {
  status: "available",
  truncated: false,
  records: [
    {
      id: "controller",
      brand: "Maker",
      model: "MPPT60",
      kind: "charge-controller",
      source: {
        type: "manufacturer-document",
        title: "Manual",
        url: "https://example.com/",
        page: 1,
        revision: "1",
        sha256: "a".repeat(64),
      },
      limitations: [],
      specifications: [
        { name: "Maximum charge current", value: 60, unit: "A", conditions: "Battery output" },
        { name: "Nominal PV power at 12 V", value: 800, unit: "W", conditions: "Rated output" },
        { name: "Maximum PV open-circuit voltage", value: 150, unit: "V", conditions: "Cold" },
        { name: "Maximum PV short-circuit current", value: 20, unit: "A", conditions: "PV input" },
      ],
    },
  ],
};
test("unknown panel manufacturer still permits the 6 × 500 W versus 60 A / 12 V advisory", () => {
  const setup = { ...newInstallation(), solarArrays: [array()] };
  const checks = solarChecks(setup, none);
  assert.equal(checks[0].arrayWatts, 3000);
  assert.match(text(checks), /3,000 W.*720 W/);
  assert.match(text(checks), /wattage alone does not establish damage/);
  assert.match(text(checks), /PV voltage still needs/);
  assert.deepEqual(checks[0].sourceIds, []);
});
test("groups assigned to one controller are summed; different controllers stay separate", () => {
  const setup = {
    ...newInstallation(),
    equipment: [controller("a"), controller("b")],
    solarArrays: [
      array({ name: "East", panelCount: 1, controllerRef: "a" }),
      array({ name: "West", panelCount: 1, controllerRef: "a" }),
      array({ name: "Shed", panelCount: 1, controllerRef: "b" }),
    ],
  };
  const checks = solarChecks(setup, known);
  assert.match(text(checks.slice(0, 2)), /1,000 W.*800 W/);
  assert.equal(checks[2].findings.filter((f) => f.level === "warning").length, 0);
});
test("an ambiguous same-model controller reference does not silently assign an array", () => {
  const setup = {
    ...newInstallation(),
    equipment: [controller("a"), controller("b")],
    solarArrays: [array({ controllerRef: "MPPT60" })],
  };
  assert.equal(solarChecks(setup, known)[0].controller, null);
  assert.deepEqual(solarChecks(setup, known)[0].sourceIds, []);
});
test("cold Voc and input Isc are checked against independent limits, not charging amps", () => {
  const setup = {
    ...newInstallation(),
    equipment: [controller("a")],
    solarArrays: [
      array({
        controllerRef: "a",
        panelsInSeries: 3,
        parallelStrings: 2,
        panelVoc: 45,
        panelIsc: 12,
        vocTemperatureCoefficient: -0.3,
        minimumTemperature: -25,
      }),
    ],
  };
  const checks = solarChecks(setup, known);
  assert.match(text(checks), /155.25 V.*150 V maximum/);
  assert.match(text(checks), /24 A.*20 A PV short-circuit/);
  assert.deepEqual(checks[0].sourceIds, ["controller"]);
});
test("inconsistent string counts suppress derived Voc; unknown models never borrow other ratings", () => {
  const setup = {
    ...newInstallation(),
    equipment: [controller("a")],
    solarArrays: [
      array({ controllerRef: "a", panelsInSeries: 5, parallelStrings: 2, panelVoc: 100 }),
    ],
  };
  assert.match(text(solarChecks(setup, known)), /does not match the panel count/);
  assert.doesNotMatch(text(solarChecks(setup, known)), /500 V/);
  setup.equipment[0].model = "MPPT60-G3";
  assert.deepEqual(solarChecks(setup, known)[0].sourceIds, []);
});
test("partial array updates retain watts and count without requesting a panel brand", () => {
  const setup = {
    ...newInstallation(),
    equipment: [{ ...controller("panels"), kind: "panel" as const, model: null }],
    solarArrays: [array()],
  };
  const patch = solarArraySchema.parse({
    ...array(),
    panelCount: null,
    panelWatts: null,
    controllerRef: "a",
    bankVoltage: 24,
  });
  const merged = mergeExtraction(
    setup,
    { observations: [], facts: [], absent: [], solarArrays: [patch] },
    "m2",
    [],
  );
  assert.equal(merged.solarArrays![0].panelCount, 6);
  assert.equal(merged.solarArrays![0].panelWatts, 500);
  assert.equal(merged.solarArrays![0].bankVoltage, 24);
  assert.deepEqual(merged.solarArrays![0].messageIds, ["m1", "m2"]);
  assert.equal(
    questions(merged).some((q) => q.id === "model:panels"),
    false,
  );
});
