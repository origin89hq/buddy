// One paid model call in an isolated local session, deleted in finally.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(new URL("../package.json", import.meta.url))("playwright");
const base = process.env.BUDDY_BROWSER_ORIGIN ?? "http://127.0.0.1:8792";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Local preview only");
const output = resolve("test-results", `feedback-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1000, height: 740 } });
const errors = [],
  results = {};
let sessionCreated = false;
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/storybook/iframe.html?id=components-buttons--states&viewMode=story`, {
    waitUntil: "load",
  });
  await page.locator('[data-slot="button"]').first().waitFor();
  results.buttons = await page.locator('[data-slot="button"]').evaluateAll((buttons) =>
    buttons.map((button) => {
      const css = getComputedStyle(button);
      return {
        text: button.textContent,
        disabled: button.disabled,
        color: css.color,
        background: css.backgroundColor,
        opacity: css.opacity,
        weight: css.fontWeight,
      };
    }),
  );
  assert.equal(results.buttons[0].color, "rgb(255, 255, 255)");
  assert.equal(results.buttons[1].opacity, "1");
  assert.notEqual(results.buttons[0].background, results.buttons[1].background);
  assert.equal(results.buttons[1].background, results.buttons[3].background);
  await page.screenshot({ path: resolve(output, "buttons-desktop.png") });
  await page.setViewportSize({ width: 390, height: 740 });
  await page.screenshot({ path: resolve(output, "buttons-mobile.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.goto(`${base}/buddy/`, { waitUntil: "load" });
  await page.locator(".poc-messages .is-assistant").waitFor();
  sessionCreated = true;
  await page
    .getByRole("textbox", { name: "Message Buddy" })
    .fill(
      "Could a Victron Energy SmartShunt 300A help monitor a 12 V lead-acid bank? What readings and port could Origin89 use, and is its integration already implemented? Catalogue question only; do not add equipment to my setup.",
    );
  const response = page.waitForResponse((r) => r.url().endsWith("/api/buddy/chat"));
  const started = Date.now();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator(".poc-knowledge-preview").waitFor({ timeout: 10000 });
  results.firstSpecsMs = Date.now() - started;
  assert.match(await page.locator(".poc-knowledge-preview").innerText(), /SmartShunt 300A/);
  await page.locator(".poc-knowledge-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "early-specs-mobile.png") });
  await page.waitForFunction(() => !document.querySelector(".poc-reading"), null, {
    timeout: 30000,
  });
  results.completeMs = Date.now() - started;
  const wire = await (await response).text();
  const event = wire
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "data-knowledge");
  assert.ok(event?.transient);
  results.lookupMs = event.data.lookupMs;
  const snapshot = await page.evaluate(async () => (await fetch("/api/buddy/session")).json());
  results.answer = snapshot.messages.at(-1).parts.find((part) => part.type === "text").text;
  assert.match(results.answer, /VE\.Direct/i);
  assert.match(results.answer, /not implemented|pending|not yet|isn.t implemented|isn.t ready/i);
  assert.match(results.answer, /state of charge|SOC/i);
  assert.equal(snapshot.installation.equipment.length, 0);
  assert.equal(await page.locator(".poc-error").count(), 0);
  assert.equal(await page.locator(".poc-knowledge-preview").count(), 0);
  assert.ok(results.firstSpecsMs < results.completeMs);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(output, "reply-mobile.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "verification.json"),
    JSON.stringify({ ...results, errors, inferenceCalls: 1 }, null, 2),
  );
  console.log(JSON.stringify({ output, ...results, errors }));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      {
        error: error.message,
        ...results,
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
  if (sessionCreated)
    await page
      .evaluate(async () => {
        await fetch("/api/buddy/session", { method: "DELETE" });
      })
      .catch(() => {});
  await browser.close();
}
