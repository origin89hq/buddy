import assert from "node:assert/strict";
import { test } from "node:test";
import { costUsd } from "../harness/pricing.mjs";

test("price includes cached image/input tokens and counts reasoning only once", () => {
  const usage = [
    {
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 100,
    },
  ];
  assert.equal(costUsd("openai/gpt-5.6-terra", usage), 0.00368);
  assert.equal(costUsd("openai/gpt-5.6-terra", usage, false), 0.0044);
});
test("missing prices or usage stay unknown, never free", () => {
  assert.equal(costUsd("unlisted-model", [{ inputTokens: 10, outputTokens: 1 }]), null);
  assert.equal(costUsd("openai/gpt-5.6-terra", []), null);
  assert.equal(costUsd("openai/gpt-5.6-terra", [{ inputTokens: 100, outputTokens: null }]), null);
});
