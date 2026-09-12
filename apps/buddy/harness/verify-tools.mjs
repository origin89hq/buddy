import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { newInstallation } from "@origin89/buddy";
import { costUsd, prices, pricingCheckedAt } from "./pricing.mjs";

// Paid, opt-in smoke check through the same conversation function and D1 binding.
// It does not create user sessions, upload photographs, or write catalogue data.
const origin = process.env.BUDDY_EVAL_ORIGIN ?? "http://127.0.0.1:8793";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Tool verification is local-only.");
const model = "openai/gpt-5.6-luna";
const output = new URL(
  `../test-results/tools-${new Date().toISOString().replaceAll(":", "-")}/`,
  import.meta.url,
);
await mkdir(output, { recursive: true });
const status = await (await fetch(origin)).json();
assert.equal(status.openAIConfigured, true, "The evaluator needs the configured OpenAI key.");
const cases = [
  {
    id: "known-rating",
    text: "What are the C20 and C100 capacities of a Rolls S550 battery? Catalogue research only; do not add equipment to my installation.",
    verify(result) {
      assert.match(result.reply, /428/);
      assert.match(result.reply, /556/);
      assert.equal(result.diagnostics.modelSteps, 1);
      assert.deepEqual(result.diagnostics.tools, []);
      assert.ok(result.sources.length > 0);
    },
  },
  {
    id: "partial-label",
    text: "Could you find the Rolls battery model whose label starts S55 and show the candidate's C20 and C100 ratings if the catalogue has them? I cannot read the rest of the label. This is catalogue research, not equipment I own.",
    verify(result) {
      assert.ok(
        result.diagnostics.tools.some(
          (tool) => tool.name === "search_equipment" && tool.status === "candidates",
        ),
      );
      assert.ok(
        result.diagnostics.tools.some(
          (tool) => tool.name === "get_equipment" && tool.status === "available",
        ),
      );
      assert.match(result.reply, /428/);
      assert.match(result.reply, /556/);
      assert.match(result.reply, /candidate|if |could|appears|match|confirm|likely/i);
      assert.ok(result.sources.length > 0);
    },
  },
  {
    id: "monitoring-options",
    text: "I'm considering a Victron SmartShunt. Could you look up the 300 A version: which port and readings could Origin89 use, and is the driver implemented? I'm researching it, not saying I own one.",
    verify(result) {
      assert.ok(
        result.diagnostics.tools.some(
          (tool) =>
            ["get_equipment", "get_monitoring_options"].includes(tool.name) &&
            tool.status === "available",
        ),
      );
      assert.match(result.reply, /VE\.Direct/i);
      assert.match(result.reply, /not implemented|pending|not yet|isn.t implemented|isn.t ready/i);
      assert.match(result.reply, /estimate|estimated|configuration|synchron/i);
      assert.ok(result.sources.length > 0);
    },
  },
];
const selected = process.argv.slice(2);
if (selected.some((id) => !cases.some((item) => item.id === id)))
  throw new Error("Unknown verification case.");
const report = {
  model,
  pricingCheckedAt,
  rates: prices[model],
  results: [],
  sourceHashes: Object.fromEntries(
    await Promise.all(
      ["conversation.ts", "equipment-tools.ts", "knowledge.ts", "solar-checks.ts"].map(
        async (name) => [
          name,
          createHash("sha256")
            .update(await readFile(new URL(`../src/${name}`, import.meta.url)))
            .digest("hex"),
        ],
      ),
    ),
  ),
};
let failed = false;
for (const entry of cases.filter((item) => !selected.length || selected.includes(item.id))) {
  const result = { id: entry.id, passed: false, estimatedUsd: null, uncachedUsd: null };
  try {
    const response = await fetch(`${origin}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        mode: "conversation",
        text: entry.text,
        images: [],
        installation: newInstallation(),
      }),
      signal: AbortSignal.timeout(25000),
    });
    const evaluation = await response.json();
    Object.assign(result, evaluation);
    assert.equal(response.ok, true, evaluation.error);
    result.estimatedUsd = costUsd(model, evaluation.usage);
    result.uncachedUsd = costUsd(model, evaluation.usage, false);
    assert.equal(evaluation.scope, "setup");
    assert.deepEqual(evaluation.result.observations, []);
    assert.deepEqual(evaluation.result.facts, []);
    assert.deepEqual(evaluation.result.solarArrays, []);
    assert.equal(evaluation.usage.length, evaluation.diagnostics.modelSteps);
    entry.verify(evaluation);
    result.passed = true;
  } catch (error) {
    result.failure = error.message;
    failed = true;
  }
  report.results.push(result);
  await writeFile(new URL("verification.json", output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: fileURLToPath(output), ...result }));
}
if (failed) process.exitCode = 1;
