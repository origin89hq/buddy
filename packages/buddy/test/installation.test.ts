import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureRounds } from "../src/fixtures.ts";
import {
  extractionSchema,
  manufacturerReference,
  mergeExtraction,
  newInstallation,
  nextQuestion,
} from "../src/index.ts";

test("three photo rounds build inventory, deduplicate the MPPT and ask for the battery label", () => {
  let record = mergeExtraction(newInstallation(), fixtureRounds[0], "board", ["photo-board"]);
  assert.equal(nextQuestion(record)?.id, "inverter");
  record = mergeExtraction(record, fixtureRounds[1], "inverter", ["photo-wide"]);
  assert.equal(record.equipment.filter((item) => item.kind === "charge-controller").length, 1);
  assert.equal(
    record.equipment.find((item) => item.kind === "charge-controller")?.photoIds.length,
    2,
  );
  assert.equal(nextQuestion(record)?.id, "battery");
  record = mergeExtraction(record, fixtureRounds[2], "bank", ["photo-bank"]);
  assert.equal(record.equipment.find((item) => item.kind === "battery")?.quantity, 6);
  assert.match(nextQuestion(record)!.text, /model label on one battery/);
  assert.equal(
    record.facts.length,
    0,
    "a visible battery count does not imply voltage, chemistry or wiring",
  );
  assert.ok(record.equipment.every((item) => !item.confirmed));
});
test("skip preserves an unanswered question and moves on to panels", () => {
  const record = fixtureRounds.reduce(
    (state, round, i) => mergeExtraction(state, round, `${i}`, []),
    newInstallation(),
  );
  const batteryLabel = nextQuestion(record)!;
  record.deferred.push(batteryLabel.id);
  assert.equal(nextQuestion(record)?.id, "panel");
  assert.ok(record.deferred.includes(batteryLabel.id));
});
test("confirmed identities survive contrary AI observations", () => {
  const before = mergeExtraction(newInstallation(), fixtureRounds[0], "first", []);
  const original = before.equipment[0];
  original.confirmed = true;
  const extraction = structuredClone(fixtureRounds[0]);
  extraction.observations[0].existingId = original.id;
  extraction.observations[0].model = "MADE-UP";
  const after = mergeExtraction(before, extraction, "next", []);
  assert.equal(after.equipment[0].model, "XTRA4210N");
  assert.ok(after.equipment[0].confirmed);
});
test("a second controller with the same model remains separate", () => {
  const before = mergeExtraction(newInstallation(), fixtureRounds[0], "first", []);
  const extraction = structuredClone(fixtureRounds[0]);
  extraction.observations = [extraction.observations[0]];
  extraction.observations[0].additionalUnit = true;
  const after = mergeExtraction(before, extraction, "second", []);
  assert.equal(after.equipment.filter((item) => item.kind === "charge-controller").length, 2);
});
test("new photo evidence cannot mark equipment confirmed and exact models do not inherit a G3 reference", () => {
  const parsed = extractionSchema.parse({
    ...fixtureRounds[0],
    observations: fixtureRounds[0].observations.map((item) => ({
      ...item,
      confirmed: true,
    })),
  });
  const record = mergeExtraction(newInstallation(), parsed, "first", []);
  assert.equal(record.equipment[0].confirmed, false);
  assert.ok(manufacturerReference(record.equipment[0]));
  record.equipment[0].model = "XTRA4210N G3";
  assert.equal(manufacturerReference(record.equipment[0]), null);
});
test("unlabelled protection devices do not collapse into one entry", () => {
  const extraction = structuredClone(fixtureRounds[0]);
  const item = extraction.observations.find((item) => item.kind === "distribution")!;
  extraction.observations = [
    { ...item, name: "Fuse block", brand: null, model: null },
    { ...item, name: "Breaker box", brand: null, model: null },
  ];
  assert.equal(mergeExtraction(newInstallation(), extraction, "photo", []).equipment.length, 2);
});
test("a newly readable model fills a blank reviewed field and needs fresh review", () => {
  const before = mergeExtraction(newInstallation(), fixtureRounds[2], "bank", []);
  before.equipment[0].confirmed = true;
  const extraction = structuredClone(fixtureRounds[2]);
  extraction.observations[0].existingId = before.equipment[0].id;
  extraction.observations[0].model = "User supplied example model";
  const after = mergeExtraction(before, extraction, "label", []);
  assert.equal(after.equipment[0].model, "User supplied example model");
  assert.equal(after.equipment[0].confirmed, false);
});
test("placeholder unknowns never become electrical facts", () => {
  const extraction = {
    observations: [],
    absent: [],
    facts: [
      {
        key: "battery_voltage" as const,
        value: "null",
        evidence: "Not visible",
      },
    ],
  };
  assert.deepEqual(mergeExtraction(newInstallation(), extraction, "photo", []).facts, []);
});
