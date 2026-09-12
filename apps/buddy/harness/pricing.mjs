// USD per million tokens, standard on-demand tier. Refresh before a production decision.
export const pricingCheckedAt = "2026-09-08";
export const prices = {
  "openai/gpt-5.6-luna": {
    input: 0.2,
    cached: 0.02,
    output: 1.2,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  },
  "openai/gpt-5.6-terra": {
    input: 2,
    cached: 0.2,
    output: 12,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  "openai/gpt-5.6-sol": {
    input: 4,
    cached: 0.4,
    output: 20,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  "@cf/google/gemma-4-26b-a4b-it": {
    input: 0.1,
    output: 0.3,
    source: "https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/",
  },
  "@cf/qwen/qwen3.8-27b": {
    input: 0.45,
    output: 3.2,
    source: "https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/",
  },
  "@cf/moonshotai/kimi-k2.6": {
    input: 0.95,
    cached: 0.16,
    output: 4,
    source: "https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/",
  },
  "@cf/moondream/moondream3.1-9B-A2B": {
    input: 0.3,
    output: 1,
    source: "https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/",
  },
};
export function costUsd(model, usage, useCacheDiscount = true) {
  const rate = prices[model];
  if (
    !rate ||
    !usage?.length ||
    usage.some((part) => part.inputTokens == null || part.outputTokens == null)
  )
    return null;
  return usage.reduce((total, part) => {
    const cached = useCacheDiscount ? Math.min(part.inputTokens, part.cachedInputTokens ?? 0) : 0;
    // outputTokens already includes reasoning tokens. Never add those twice.
    return (
      total +
      ((part.inputTokens - cached) * rate.input +
        cached * (rate.cached ?? rate.input) +
        part.outputTokens * rate.output) /
        1_000_000
    );
  }, 0);
}
