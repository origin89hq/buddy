import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractionSchema, newInstallation, turnSchema } from "@origin89/buddy";
import { fixtureRounds } from "@origin89/buddy/fixtures";

assert.deepEqual(newInstallation().equipment, []);
assert.equal(turnSchema.safeParse({ id: "turn", text: "", photoIds: [] }).success, false);
assert.equal(turnSchema.safeParse({ id: "turn", text: "My cottage", photoIds: [] }).success, true);
for (const round of fixtureRounds) {
  assert.equal(extractionSchema.safeParse(round).success, true);
}
const entry = new URL(import.meta.resolve("@origin89/buddy"));
assert.ok((await readFile(new URL("./index.d.ts", entry), "utf8")).length > 0);
assert.ok((await readFile(new URL("./fixtures.d.ts", entry), "utf8")).length > 0);
const configUrl = new URL(import.meta.resolve("@origin89/buddy/fixture-config"));
const config = JSON.parse(await readFile(configUrl, "utf8"));
assert.equal(config.workers_dev, false);
assert.equal(config.env.fixture.vars.BUDDY_MODE, "fixture");
assert.ok((await readFile(new URL(config.main, configUrl), "utf8")).length > 0);
assert.ok((await readFile(new URL("../CHANGELOG.md", entry), "utf8")).length > 0);
console.log("Installed package exports, schemas, fixture Worker and declarations passed.");
