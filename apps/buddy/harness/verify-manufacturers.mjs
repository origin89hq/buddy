// Three paid chat calls, isolated local browser session, removed in finally.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(new URL("../package.json", import.meta.url))("playwright");
const base = process.env.BUDDY_BROWSER_ORIGIN ?? "http://127.0.0.1:8792";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Local preview only");
const output = resolve(
  "test-results",
  `manufacturers-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [],
  results = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/buddy/`, { waitUntil: "load" });
  await page.locator(".poc-messages .is-assistant").waitFor();
  const scenarios = [
    [
      "What are the nominal voltage and Ah capacity of a Rolls R36-100LFP battery? Catalogue question only; it is not installed here.",
      /38\.4/,
      /100\s*Ah/i,
    ],
    [
      "What are the DC input voltage and continuous output power of an EPEVER IP2000-11-Plus inverter? Catalogue question only; it is not installed here.",
      /12\s*V/i,
      /2[,.]?000\s*W|2\s*kW/i,
    ],
    [
      "My roof array has 6 panels rated 500 watts each; I don't know their brand. They all feed my EPEVER XTRA4210N controller, which charges my 12 V battery bank. I don't know the string layout.",
      null,
      null,
    ],
  ];
  for (const [prompt, first, second] of scenarios) {
    const count = await page.locator(".poc-messages .is-assistant").count();
    await page.getByRole("textbox", { name: "Message Buddy" }).fill(prompt);
    const start = Date.now();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll(".poc-messages .is-assistant").length > n &&
        !document.querySelector(".poc-reading"),
      count,
      { timeout: 30_000 },
    );
    const elapsedMs = Date.now() - start;
    assert.equal(await page.locator(".poc-error").count(), 0);
    const snapshot = await page.evaluate(async () => (await fetch("/api/buddy/session")).json());
    const message = snapshot.messages.at(-1),
      answer = message.parts.find((p) => p.type === "text").text;
    if (first) {
      assert.match(answer, first);
      assert.match(answer, second);
      assert.equal(snapshot.installation.equipment.length, 0);
      assert.equal(snapshot.installation.solarArrays?.length ?? 0, 0);
    } else {
      assert.equal(snapshot.installation.solarArrays.length, 1);
      const array = snapshot.installation.solarArrays[0];
      assert.equal(array.panelCount, 6);
      assert.equal(array.panelWatts, 500);
      assert.equal(array.bankVoltage, 12);
      const check = message.metadata.solarChecks[0];
      assert.equal(check.arrayWatts, 3000);
      assert.ok(check.controller);
      assert.match(check.findings.map((f) => f.text).join(" "), /3,000 W.*520 W/);
      await page.locator(".poc-solar-check").last().scrollIntoViewIfNeeded();
    }
    assert.ok(message.metadata.sources.length);
    results.push({ prompt, elapsedMs, answer, metadata: message.metadata });
  }
  await page.screenshot({ path: resolve(output, "desktop.png"), animations: "disabled" });
  await page.reload({ waitUntil: "load" });
  await page.locator(".poc-solar-check").waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(".poc-solar-check").last().scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${width}px overflow`,
    );
    await page.screenshot({ path: resolve(output, `mobile-${width}.png`), animations: "disabled" });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "verification.json"),
    JSON.stringify(
      {
        results,
        errors,
        inferenceCalls: 3,
        checks: [
          "live battery and inverter citations",
          "hypotheticals not installed",
          "unknown panel brand accepted",
          "per-controller calculation",
          "refresh persistence",
          "390/320px layout",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      output,
      elapsedMs: results.map((r) => r.elapsedMs),
      answers: results.map((r) => r.answer),
      errors,
    }),
  );
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      {
        error: error.message,
        results,
        errors,
        body: await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await page
    .evaluate(async () => {
      await fetch("/api/buddy/session", { method: "DELETE" });
    })
    .catch(() => {});
  await browser.close();
}
