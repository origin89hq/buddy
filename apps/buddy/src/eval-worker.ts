import { type Installation, newInstallation } from "@origin89/buddy";
import { z } from "zod";
import { converse } from "./conversation";
import { boundedBody, sameOrigin } from "./http";
import { extract, type InferenceUsage } from "./inference";

const candidates = [
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-luna",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3.8-27b",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moondream/moondream3.1-9B-A2B",
  "@cf/llava-hf/llava-1.5-7b-hf",
] as const;
const inputSchema = z.object({
  model: z.enum(candidates),
  text: z.string().max(3000),
  mode: z.enum(["photos", "conversation"]).default("photos"),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(3000),
      }),
    )
    .max(6)
    .default([]),
  images: z
    .array(
      z.object({
        base64: z.string().max(4_200_000),
        mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      }),
    )
    .max(2),
  installation: z
    .custom<Installation>(
      (value) => !!value && typeof value === "object" && "version" in value && value.version === 1,
    )
    .optional(),
});
// A separate loopback-only evaluator. Not imported or routed by the Buddy website Worker.
export default {
  async fetch(request, env) {
    if (!["127.0.0.1", "localhost"].includes(new URL(request.url).hostname) || !sameOrigin(request))
      return new Response(null, { status: 403 });
    if (request.method === "GET")
      return Response.json({
        candidates,
        openAIConfigured: !!env.OPENAI_API_KEY,
      });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/evaluate")
      return new Response(null, { status: 404 });
    try {
      const input = inputSchema.parse(
        JSON.parse(new TextDecoder().decode(await boundedBody(request, 9_000_000))),
      );
      const start = Date.now();
      const usage: InferenceUsage[] = [];
      if (input.mode === "conversation") {
        const response = await converse(
          {
            OPENAI_API_KEY: env.OPENAI_API_KEY,
            BUDDY_CHAT_MODEL: input.model,
            KNOWLEDGE: env.KNOWLEDGE,
          },
          input.installation ?? newInstallation(),
          input.messages.map((message, index) => ({
            id: String(index),
            role: message.role,
            parts: [{ type: "text", text: message.text }],
          })),
          input.text,
          (value) => usage.push(value),
        );
        return Response.json({
          result: response.extraction,
          reply: response.reply,
          scope: response.scope,
          sources: response.sources,
          diagnostics: response.diagnostics,
          durationMs: Date.now() - start,
          usage,
        });
      }
      const result = await extract(
        {
          AI: env.AI,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          BUDDY_MODEL: input.model,
        },
        input.installation ?? newInstallation(),
        input.text,
        input.images.map((image) => ({
          mediaType: image.mediaType,
          bytes: Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0)),
        })),
        (value) => usage.push(value),
      );
      return Response.json({ result, durationMs: Date.now() - start, usage });
    } catch (error) {
      // CLI reports errors separately from scores; failed inference must never look like a zero-equipment detection.
      return Response.json(
        {
          error: error instanceof Error ? error.message.slice(0, 800) : "Evaluation failed",
        },
        { status: 502 },
      );
    }
  },
} satisfies ExportedHandler<Pick<Env, "AI"> & { OPENAI_API_KEY?: string; KNOWLEDGE?: D1Database }>;
