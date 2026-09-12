import assert from "node:assert/strict";
import { test } from "node:test";
import { newInstallation } from "@origin89/buddy";
import { MockLanguageModelV4 } from "ai/test";
import { converse } from "../src/conversation.ts";
import { knowledgeDatabase, seed } from "./helpers/knowledge-db.ts";

const answer = (patch = {}) => ({
  scope: "setup",
  reply: "The catalogue lists 428 Ah at the 20-hour rate.",
  sourceIds: [seed.id, "invented"],
  extraction: { observations: [], facts: [], absent: [] },
  solarArrays: [],
  ...patch,
});
const generated = (content, reason = "stop") => ({
  content,
  finishReason: { unified: reason, raw: reason },
  warnings: [],
  usage: {
    inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: undefined },
    outputTokens: { total: 30, text: 30, reasoning: 0 },
  },
});
const toolCall = (name, input) =>
  generated(
    [
      {
        type: "tool-call",
        toolCallId: crypto.randomUUID(),
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    "tool-calls",
  );
const final = (value = answer()) => generated([{ type: "text", text: JSON.stringify(value) }]);

test("known equipment remains a single model call with source allowlisting and one usage entry", async () => {
  const store = knowledgeDatabase();
  try {
    const model = new MockLanguageModelV4({ doGenerate: final() }),
      usage = [],
      reserved = [];
    const result = await converse(
      { BUDDY_CHAT_MODEL: "openai/test", KNOWLEDGE: store.db },
      newInstallation(),
      [],
      "What is the capacity of Rolls S550?",
      (u) => usage.push(u),
      {
        model,
        beforeStep: async (n) => {
          reserved.push(n);
        },
      },
    );
    assert.equal(model.doGenerateCalls.length, 1);
    assert.deepEqual(reserved, [0]);
    assert.equal(usage.length, 1);
    assert.equal(result.sources.length, 1);
    assert.equal(result.diagnostics.tools.length, 0);
    assert.deepEqual(result.extraction.observations, []);
  } finally {
    store.sqlite.close();
  }
});

test("real AI SDK loop searches, fetches exact specs, then produces a sourced answer and accounts for every step", async () => {
  const store = knowledgeDatabase();
  try {
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        if (step++ === 0)
          return toolCall("search_equipment", {
            brand: "Rolls",
            modelPrefix: "S55",
            kind: "battery",
          });
        if (step === 2) {
          assert.match(JSON.stringify(call.prompt), /candidates/);
          return toolCall("get_equipment", { brand: "Rolls", model: "S-550" });
        }
        assert.match(JSON.stringify(call.prompt), /428/);
        assert.equal(call.toolChoice?.type, "none");
        return final();
      },
    });
    const usage = [],
      reserved = [],
      setup = newInstallation(),
      before = JSON.stringify(setup);
    const result = await converse(
      { BUDDY_CHAT_MODEL: "openai/test", KNOWLEDGE: store.db },
      setup,
      [],
      "Could you look up a Rolls battery with S55 at the start of its label?",
      (u) => usage.push(u),
      {
        model,
        beforeStep: async (n) => {
          reserved.push(n);
        },
      },
    );
    assert.deepEqual(reserved, [0, 1, 2]);
    assert.equal(usage.length, 3);
    assert.equal(
      usage.reduce((sum, u) => sum + u.inputTokens, 0),
      300,
    );
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].id, seed.id);
    assert.deepEqual(
      result.diagnostics.tools.map((trace) => trace.name),
      ["search_equipment", "get_equipment"],
    );
    assert.equal(JSON.stringify(setup), before);
  } finally {
    store.sqlite.close();
  }
});

test("an unavailable DB returns a tool result without invented source links", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("get_equipment", { brand: "Rolls", model: "S550" }),
      final(answer({ reply: "The catalogue is unavailable; the capacity remains unknown." })),
    ],
  });
  const result = await converse(
    { BUDDY_CHAT_MODEL: "openai/test" },
    newInstallation(),
    [],
    "Look up the battery capacity.",
    undefined,
    { model },
  );
  assert.deepEqual(result.sources, []);
  assert.equal(result.diagnostics.tools[0].status, "unavailable");
});

test("budget denial prevents the next provider call and retains usage from the completed step", async () => {
  const store = knowledgeDatabase();
  try {
    const model = new MockLanguageModelV4({
      doGenerate: toolCall("get_equipment", { brand: "Rolls", model: "S550" }),
    });
    const usage = [];
    await assert.rejects(
      converse(
        { BUDDY_CHAT_MODEL: "openai/test", KNOWLEDGE: store.db },
        newInstallation(),
        [],
        "Look it up.",
        (u) => usage.push(u),
        {
          model,
          beforeStep: async (n) => {
            if (n > 0) throw new Error("Daily budget exhausted");
          },
        },
      ),
      /Daily budget exhausted/,
    );
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(usage.length, 1);
  } finally {
    store.sqlite.close();
  }
});

test("off-topic output cannot write extracted equipment or expose retrieved citations", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: final(answer({ scope: "outside-setup", solarArrays: [] })),
  });
  const result = await converse(
    { BUDDY_CHAT_MODEL: "openai/test" },
    newInstallation(),
    [],
    "Write a movie review.",
    undefined,
    { model },
  );
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.extraction, { observations: [], facts: [], absent: [] });
  assert.match(result.reply, /app preview/);
});
