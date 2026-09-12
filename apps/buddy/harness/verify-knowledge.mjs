import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(new URL("../package.json", import.meta.url))("playwright");
const base = process.env.BUDDY_BROWSER_ORIGIN ?? "http://127.0.0.1:8792";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("This check is local-only");
const output = resolve(
  "test-results",
  `knowledge-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/buddy/`, { waitUntil: "load" });
  await page.locator(".poc-messages .is-assistant").waitFor();
  const initial = await page.evaluate(async () => (await fetch("/api/buddy/session")).json());
  assert.equal(initial.mode, "live");
  assert.equal(initial.installation.equipment.length, 0);
  await page
    .getByRole("textbox", { name: "Message Buddy" })
    .fill(
      "What are the short-circuit current and maximum-power current of an Ablytek 6MN6A270 solar panel? This is a catalogue question; I am not saying this is installed.",
    );
  const started = Date.now();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".poc-messages .is-assistant").length > 1 &&
      !document.querySelector(".poc-reading"),
    undefined,
    { timeout: 30_000 },
  );
  const elapsedMs = Date.now() - started;
  assert.equal(await page.locator(".poc-error").count(), 0);
  const answer = await page.locator(".poc-messages .is-assistant").last().innerText();
  assert.match(answer, /9\.34/);
  assert.match(answer, /8\.81/);
  assert.match(answer, /STC|standard test|25\s*°?C/i);
  const source = page.locator(".poc-sources a").last();
  assert.match(await source.innerText(), /row 4/);
  assert.match(
    await source.getAttribute("href"),
    /github\.com\/NatLabRockies\/SAM\/blob\/[a-f0-9]{40}\//,
  );
  await page.screenshot({ path: resolve(output, "desktop.png"), animations: "disabled" });
  await page.reload({ waitUntil: "load" });
  await page.locator(".poc-sources a").waitFor();
  const saved = await page.evaluate(async () => (await fetch("/api/buddy/session")).json());
  assert.equal(saved.installation.equipment.length, 0);
  assert.equal(saved.installation.facts.length, 0);
  assert.equal(saved.messages.at(-1).metadata.sources[0].row, 4);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${width}px overflow`,
    );
    await page.screenshot({ path: resolve(output, `mobile-${width}.png`), animations: "disabled" });
  }
  assert.deepEqual(errors, []);
  const result = {
    elapsedMs,
    answer,
    source: saved.messages.at(-1).metadata.sources[0],
    errors,
    checks: [
      "live catalogue ratings",
      "source row and pinned revision",
      "refresh persistence",
      "no invented installed equipment or facts",
      "390/320px no overflow",
    ],
    inferenceCalls: 1,
  };
  await writeFile(resolve(output, "verification.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...result }));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      {
        error: error.message,
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
  // Only this fresh browser context's disposable session is cleared.
  await page
    .evaluate(async () => {
      await fetch("/api/buddy/session", { method: "DELETE" });
    })
    .catch(() => {});
  await browser.close();
}
