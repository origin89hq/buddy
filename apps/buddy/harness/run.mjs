import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeExtraction, newInstallation, nextQuestion } from "@origin89/buddy";
import { costUsd, prices, pricingCheckedAt } from "./pricing.mjs";

const requireBuddy = createRequire(new URL("../package.json", import.meta.url));
const sharp = requireBuddy("sharp");
const root = dirname(fileURLToPath(import.meta.url));
const manifestPath = process.argv[2];
if (!manifestPath)
  throw new Error(
    "Usage: node harness/run.mjs /private/path/photos.json [model-id ...]. Start the local evaluator first (pnpm buddy:eval:dev).",
  );
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const origin = process.env.BUDDY_EVAL_ORIGIN || "http://127.0.0.1:8793";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("The evaluator must be on loopback.");
const models = process.argv.slice(3).length ? process.argv.slice(3) : manifest.models;
const repeats = Number(process.env.BUDDY_EVAL_REPEATS ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
  throw new Error("BUDDY_EVAL_REPEATS must be 1–5.");
const output = resolve(root, "../test-results", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const rounds = [];
for (const round of manifest.rounds) {
  const images = [];
  for (const path of round.photos) {
    // Same orientation, 2048px limit and JPEG quality as the browser. Originals stay untouched.
    const bytes = await sharp(await readFile(resolve(dirname(manifestPath), path)))
      .rotate()
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    images.push({ base64: bytes.toString("base64"), mediaType: "image/jpeg" });
  }
  rounds.push({ ...round, images });
}
const results = [];
const targetMs = manifest.targetMs ?? 10_000;
const setupBudgetUsd = manifest.setupBudgetUsd ?? 0.25;
const plannedTurns = manifest.plannedTurns ?? 12;
const retryAllowance = manifest.retryAllowance ?? 2;
const provenance = {
  pricingCheckedAt,
  prices,
  targetMs,
  setupBudgetUsd,
  plannedTurns,
  retryAllowance,
  inferenceHash: createHash("sha256")
    .update(await readFile(resolve(root, "../src/inference.ts")))
    .digest("hex"),
  conversationHash: createHash("sha256")
    .update(await readFile(resolve(root, "../src/conversation.ts")))
    .digest("hex"),
  equipmentToolsHash: createHash("sha256")
    .update(await readFile(resolve(root, "../src/equipment-tools.ts")))
    .digest("hex"),
  inventoryHash: createHash("sha256")
    .update(await readFile(resolve(root, "../../../packages/buddy/src/index.ts")))
    .digest("hex"),
  imageHashes: rounds.map((round) => ({
    id: round.id,
    hashes: round.images.map((image) => createHash("sha256").update(image.base64).digest("hex")),
  })),
  preprocessing:
    "Orientation normalized; JPEG quality 90; max 2048px; same prepared images across candidates",
};
for (const { model, repetition } of models.flatMap((model) =>
  Array.from({ length: repeats }, (_, i) => ({ model, repetition: i + 1 })),
)) {
  let installation = newInstallation();
  const messages = [];
  const record = {
    model,
    repetition,
    rounds: [],
    passed: 0,
    total: 0,
    errors: 0,
    durationMs: 0,
  };
  for (const round of rounds) {
    const checks = [];
    const check = (name, passed) => checks.push({ name, passed: !!passed });
    try {
      const before = structuredClone(installation);
      const response = await fetch(`${origin}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          mode: manifest.mode ?? "photos",
          messages: messages.slice(-6),
          text: round.text || "",
          installation,
          images: round.images,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const evaluation = await response.json();
      if (!response.ok) throw new Error(evaluation.error || `HTTP ${response.status}`);
      installation = mergeExtraction(
        installation,
        evaluation.result,
        round.id,
        round.photos.map((_, index) => `${round.id}:${index}`),
      );
      for (const kind of round.expect.kinds ?? [])
        check(
          `Identified ${kind}`,
          installation.equipment.some((item) => item.kind === kind),
        );
      for (const [kind, model] of Object.entries(round.expect.models ?? {}))
        check(
          `Exact ${kind} model: ${model}`,
          installation.equipment.some(
            (item) =>
              item.kind === kind &&
              item.model?.toLowerCase().replace(/[^a-z0-9]/g, "") ===
                model.toLowerCase().replace(/[^a-z0-9]/g, ""),
          ),
        );
      for (const [kind, quantity] of Object.entries(round.expect.quantities ?? {}))
        check(
          `${kind} count: ${quantity}`,
          installation.equipment.some((item) => item.kind === kind && item.quantity === quantity),
        );
      for (const kind of round.expect.singleEntryKinds ?? [])
        check(
          `No duplicate ${kind}`,
          installation.equipment.filter((item) => item.kind === kind).length === 1,
        );
      for (const kind of round.expect.unknownModels ?? [])
        check(
          `${kind} model stays unknown`,
          installation.equipment.filter((item) => item.kind === kind).every((item) => !item.model),
        );
      for (const key of round.expect.unknownFacts ?? [])
        check(`No invented ${key}`, !installation.facts.some((fact) => fact.key === key));
      if (round.expect.nextQuestion)
        check(
          `Next question: ${round.expect.nextQuestion}`,
          nextQuestion(installation)?.id.startsWith(round.expect.nextQuestion),
        );
      if (round.expect.replyMatches)
        check(
          "Relevant conversational answer",
          new RegExp(round.expect.replyMatches, "i").test(evaluation.reply ?? ""),
        );
      if (round.expect.replyExcludes)
        check(
          "No unsupported instructions",
          !new RegExp(round.expect.replyExcludes, "i").test(evaluation.reply ?? ""),
        );
      if (round.expect.scope)
        check(`Scope: ${round.expect.scope}`, evaluation.scope === round.expect.scope);
      if (round.expect.unchanged)
        check(
          "Question does not change inventory",
          JSON.stringify({ ...before, revision: installation.revision }) ===
            JSON.stringify(installation),
        );
      check(
        "No AI-confirmed equipment",
        installation.equipment.every((item) => !item.confirmed),
      );
      check(`Inference within ${targetMs / 1000}s`, evaluation.durationMs <= targetMs);
      record.passed += checks.filter((check) => check.passed).length;
      record.total += checks.length;
      record.durationMs += evaluation.durationMs;
      record.rounds.push({
        id: round.id,
        durationMs: evaluation.durationMs,
        usage: evaluation.usage ?? null,
        diagnostics: evaluation.diagnostics ?? null,
        estimatedUsd: costUsd(model, evaluation.usage),
        uncachedUsd: costUsd(model, evaluation.usage, false),
        checks,
        observations: evaluation.result,
        reply: evaluation.reply,
        scope: evaluation.scope,
        installation: structuredClone(installation),
        nextQuestion: nextQuestion(installation),
      });
      messages.push(
        { role: "user", text: round.text || "Photos attached" },
        {
          role: "assistant",
          text: evaluation.reply ?? nextQuestion(installation)?.text ?? "Setup saved.",
        },
      );
      console.log(
        `${model} / ${round.id}: ${checks.filter((check) => check.passed).length}/${checks.length} · ${(evaluation.durationMs / 1000).toFixed(1)}s`,
      );
      for (const failed of checks.filter((check) => !check.passed))
        console.log(`  Miss: ${failed.name}`);
    } catch (error) {
      record.errors++;
      record.rounds.push({ id: round.id, error: error.message });
      console.log(`${model} / ${round.id}: ERROR · ${error.message.slice(0, 170)}`);
    }
    await writeFile(
      resolve(output, "progress.json"),
      JSON.stringify(
        {
          dataset: manifest.name,
          provenance,
          completed: results,
          current: record,
        },
        null,
        2,
      ),
    );
  }
  results.push(record);
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        dataset: manifest.name,
        provenance,
        generatedAt: new Date().toISOString(),
        note: "Private evaluation. No image bytes or local photo paths are embedded. Scores cover these annotated examples only; model suggestions require review.",
        results,
      },
      null,
      2,
    ),
  );
}
const usd = (value) => (value == null ? "Unknown" : `$${value.toFixed(4)}`);
const rows = results
  .map((record) => {
    const knownCost = record.rounds.every((round) => round.estimatedUsd != null && !round.error);
    const actual = knownCost
      ? record.rounds.reduce((sum, round) => sum + round.estimatedUsd, 0)
      : null;
    const planning = knownCost
      ? (record.rounds.reduce((sum, round) => sum + round.uncachedUsd, 0) / rounds.length) *
        (plannedTurns + retryAllowance)
      : null;
    return `| ${record.model} · run ${record.repetition} | ${record.passed}/${record.total} | ${record.errors} | ${record.rounds.map((round) => (round.durationMs ? `${(round.durationMs / 1000).toFixed(1)}s` : "Error")).join(" / ")} | ${usd(actual)} | ${usd(planning)} | ${planning == null ? "Unknown" : planning <= setupBudgetUsd ? "Pass" : "Over budget"} |`;
  })
  .join("\n");
await writeFile(
  resolve(output, "report.md"),
  `# Buddy photo evaluation\n\n${manifest.name}\n\n| Model | Quality + speed checks | Errors | Per-round inference | Tested sequence (USD) | ${plannedTurns} turns + ${retryAllowance} retries (USD) | $${setupBudgetUsd} budget |\n|---|---:|---:|---|---:|---:|---|\n${rows}\n\nThe tested sequence has ${rounds.length} rounds. The longer-setup column is a planning scenario using the mean token count per tested round, with no cache discount; it is not an observed complete setup or a cost guarantee. Unknown usage, timeouts, or errors keep sequence cost unknown because aborted calls may still be billed. Estimates use provider-reported input/output tokens (including images and reasoning), and standard USD prices checked ${pricingCheckedAt}. Hosting, storage, network, web/specification lookup, taxes and future extra turns are excluded. Review billing to reconcile actual charges.\n\nTarget: a useful completed scan within ${targetMs / 1000}s. Inference timing includes the call from the local Worker through its provider; excludes browser preprocessing/upload. Failed rounds disqualify automatic recommendation. These few annotated photos are a regression dataset, not a general benchmark or meaningful p95 measurement. Inspect results.json for individual misses, token counts, source pricing and reproducibility hashes.\n`,
);
console.log(`Report: ${output}/report.md`);
