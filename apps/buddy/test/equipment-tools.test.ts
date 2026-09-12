import assert from "node:assert/strict";
import { test } from "node:test";
import { type Installation, newInstallation } from "@origin89/buddy";
import { loadIntegrationProfiles } from "../scripts/integration-profiles.mjs";
import {
  createEquipmentTools,
  equipmentSearchQuery,
  equipmentToolLimits,
  searchEquipment,
} from "../src/equipment-tools.ts";
import { citedSources, retrieveKnowledge } from "../src/knowledge.ts";
import { knowledgeDatabase, seed } from "./helpers/knowledge-db.ts";

const empty = () => ({ status: "no-match" as const, records: [], truncated: false });
const options = { toolCallId: "test", messages: [] };

test("candidate search uses the alias index, checks brands and kinds, and never resolves partial suffixes as specs", async () => {
  const store = knowledgeDatabase([
    seed,
    { ...seed, id: "different-voltage", model: "S550/24", aliases: [] },
    { ...seed, id: "different-brand", brand: "Rolls Other", aliases: [] },
  ]);
  try {
    const plan = store.sqlite
      .prepare(`EXPLAIN QUERY PLAN ${equipmentSearchQuery}`)
      .all("rollss55", "rollss55\u{10ffff}");
    assert.ok(
      plan.some((row) =>
        /SEARCH a USING PRIMARY KEY.*lookup_key>.*lookup_key</.test(String(row.detail)),
      ),
      JSON.stringify(plan),
    );
    const found = await searchEquipment(store.db, {
      brand: "Rolls",
      modelPrefix: "S55",
      kind: "battery",
    });
    assert.equal(found.status, "candidates");
    assert.deepEqual(
      found.candidates.map((item) => item.model),
      ["S-550", "S550/24"],
    );
    assert.ok(found.candidates.every((item) => !("specifications" in item)));
    assert.equal(
      (await searchEquipment(store.db, { brand: "Rolls", modelPrefix: "S55", kind: "inverter" }))
        .candidates.length,
      0,
    );
    assert.equal(
      (await searchEquipment(store.db, { brand: "Rolls", modelPrefix: "%' OR 1=1", kind: null }))
        .candidates.length,
      0,
    );
    assert.equal(
      (await searchEquipment(store.db, { brand: "Surrette", modelPrefix: "S55", kind: null }))
        .candidates.length,
      1,
    );
  } finally {
    store.sqlite.close();
  }
});

test("search excludes inactive revisions, bad payload aliases and unreviewed records; broad searches are visibly bounded", async () => {
  const samples = Array.from({ length: 80 }, (_, i) => ({
    ...seed,
    id: `battery-${i}`,
    model: `B${String(i).padStart(3, "0")}`,
    aliases: [],
  }));
  const store = knowledgeDatabase(samples);
  try {
    store.sqlite.exec("UPDATE knowledge_records SET status='withdrawn' WHERE id='battery-0'");
    store.sqlite.exec(
      "UPDATE knowledge_records SET catalogue_id='unpublished', catalogue_revision='next' WHERE id='battery-1'",
    );
    store.sqlite.exec("INSERT INTO knowledge_aliases VALUES ('rollsaaaa', 'battery-2')");
    const found = await searchEquipment(store.db, { brand: "Rolls", modelPrefix: "", kind: null });
    assert.equal(found.truncated, true);
    assert.equal(found.candidates.length, equipmentToolLimits.candidates);
    assert.equal(found.candidates[0].model, "B002");
    assert.equal(store.queries(), 1);
  } finally {
    store.sqlite.close();
  }
});

test("app panel and monitor categories resolve the catalogue's solar-panel and battery-monitor categories", async () => {
  const store = knowledgeDatabase([
    {
      ...seed,
      id: "solar-panel",
      brand: "Ablytek",
      model: "6MN6A270",
      kind: "solar-panel",
      aliases: [],
    },
    {
      ...seed,
      id: "battery-monitor",
      brand: "Victron Energy",
      model: "SmartShunt 300A",
      kind: "battery-monitor",
      aliases: [{ brand: "Victron", model: "SmartShunt 300A" }],
    },
  ]);
  try {
    const panels = await searchEquipment(store.db, {
      brand: "Ablytek",
      modelPrefix: "6MN",
      kind: "panel",
    });
    assert.equal(panels.candidates[0]?.model, "6MN6A270");
    const monitors = await searchEquipment(store.db, {
      brand: "Victron",
      modelPrefix: "SmartShunt",
      kind: "monitor",
    });
    assert.equal(monitors.candidates[0]?.model, "SmartShunt 300A");
  } finally {
    store.sqlite.close();
  }
});

test("exact tools reuse prefetch and per-turn cache; unknown variants and arbitrary source IDs remain unavailable", async () => {
  const store = knowledgeDatabase();
  try {
    const setup = newInstallation(),
      before = JSON.stringify(setup);
    const prefetch = await retrieveKnowledge(store.db, setup, "Rolls S550");
    const service = createEquipmentTools(store.db, setup, prefetch, new AbortController().signal);
    const result = await service.tools.get_equipment.execute!(
      { brand: "Rolls", model: "S-550" },
      options,
    );
    assert.equal(result.status, "available");
    assert.equal(store.queries(), 1);
    const same = await Promise.all(
      Array.from({ length: 2 }, () =>
        service.tools.get_equipment.execute!({ brand: "Surrette", model: "S550" }, options),
      ),
    );
    assert.deepEqual(same[0], same[1]);
    assert.equal(store.queries(), 2);
    const missing = await service.tools.get_equipment.execute!(
      { brand: "Rolls", model: "S550 X" },
      options,
    );
    assert.equal(missing.status, "no-match");
    assert.equal(JSON.stringify(setup), before);
    assert.deepEqual(citedSources(service.knowledge(), ["invented-source"]), []);
    assert.equal(citedSources(service.knowledge(), [seed.id]).length, 1);
    assert.equal(service.traces.filter((trace) => trace.cached).length, 1);
  } finally {
    store.sqlite.close();
  }
});

test("conflicting exact identities and database failures cannot produce a usable specification", async () => {
  const store = knowledgeDatabase([seed, { ...seed, id: "other-revision" }]);
  try {
    const service = createEquipmentTools(
      store.db,
      newInstallation(),
      empty(),
      new AbortController().signal,
    );
    assert.equal(
      (await service.tools.get_equipment.execute!({ brand: "Rolls", model: "S550" }, options))
        .status,
      "no-match",
    );
    assert.equal(service.knowledge().records.length, 0);
  } finally {
    store.sqlite.close();
  }
  const missing = createEquipmentTools(
    undefined,
    newInstallation(),
    empty(),
    new AbortController().signal,
  );
  assert.equal(
    (await missing.tools.get_equipment.execute!({ brand: "Rolls", model: "S550" }, options)).status,
    "unavailable",
  );
});

test("monitor suggestions preserve passive/documented status, expose no commands, and do not modify the installation", async () => {
  const profiles = await loadIntegrationProfiles();
  const store = knowledgeDatabase([{ ...seed, integration: profiles["passive-lead-acid"] }]);
  try {
    const setup = newInstallation();
    const service = createEquipmentTools(store.db, setup, empty(), new AbortController().signal);
    const result = await service.tools.get_monitoring_options.execute!(
      { brand: "Rolls", model: "S550" },
      options,
    );
    assert.equal(result.records[0].integration.status, "passive");
    assert.deepEqual(result.records[0].integration.ports, []);
    assert.ok(
      result.records[0].integration.monitoringOptions.some((item) => /SmartShunt/.test(item.model)),
    );
    assert.equal(citedSources(service.knowledge(), [seed.id]).length, 1);
    assert.deepEqual(Object.keys(service.tools).sort(), [
      "check_setup",
      "get_equipment",
      "get_monitoring_options",
      "search_equipment",
    ]);
    assert.deepEqual(setup, newInstallation());
  } finally {
    store.sqlite.close();
  }
});

test("saved setup calculations reuse the deterministic checks without changing the source record", async () => {
  const setup: Installation = {
    ...newInstallation(),
    solarArrays: [
      {
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
        evidence: "User supplied",
        messageIds: ["saved"],
      },
    ],
  };
  const before = JSON.stringify(setup);
  const service = createEquipmentTools(undefined, setup, empty(), new AbortController().signal);
  const result = await service.tools.check_setup.execute!({}, options);
  assert.equal(result.checks[0].arrayWatts, 3000);
  assert.ok(result.checks[0].findings.some((finding) => /720 W/.test(finding.text)));
  assert.ok(
    result.checks[0].findings.some((finding) => /PV voltage still needs/.test(finding.text)),
  );
  assert.equal(JSON.stringify(setup), before);
});

test("tool execution and cancellation are bounded even if the model repeats parallel calls", async () => {
  const store = knowledgeDatabase();
  try {
    const controller = new AbortController();
    const service = createEquipmentTools(store.db, newInstallation(), empty(), controller.signal);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.tools.get_equipment.execute!({ brand: "Rolls", model: "S550" }, options),
      ),
    );
    assert.ok(
      results.filter((result) => result.status === "available").length <= equipmentToolLimits.calls,
    );
    assert.equal(
      results.filter((result) => result.status === "budget-exhausted").length >= 4,
      true,
    );
    assert.equal(store.queries(), 1);
    controller.abort();
    await assert.rejects(
      service.tools.get_equipment.execute!({ brand: "Rolls", model: "S550" }, options),
    );
  } finally {
    store.sqlite.close();
  }
});
