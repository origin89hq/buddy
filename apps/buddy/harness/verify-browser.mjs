import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const { chromium } = createRequire(new URL("../package.json", import.meta.url))("playwright");
const manifestPath = process.argv[2];
if (!manifestPath)
  throw new Error(
    "Pass the private photo manifest. This browser check makes real inference calls when the server is live.",
  );
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const base = process.env.BUDDY_BROWSER_ORIGIN ?? "http://127.0.0.1:8792";
const output = resolve("test-results", `browser-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [],
  timings = [];
page.on("pageerror", (error) => errors.push(error.message));
const snapshot = () => page.evaluate(async () => (await fetch("/api/buddy/session")).json());
async function send() {
  const count = await page.locator(".poc-messages .is-assistant").count();
  const started = Date.now();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".poc-messages .is-assistant").length > count &&
      !document.querySelector(".poc-reading"),
    count,
    { timeout: 30_000 },
  );
  assert.equal(await page.locator(".poc-error").count(), 0);
  return Date.now() - started;
}
try {
  await page.goto(`${base}/buddy/`, { waitUntil: "load" });
  await page.locator(".poc-messages .is-assistant").waitFor();
  const initial = await snapshot();
  assert.equal(initial.installation.equipment.length, 0);
  assert.equal(
    await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(),
    false,
  );
  for (const round of manifest.rounds) {
    await page
      .locator('input[type="file"]')
      .setInputFiles(round.photos.map((path) => resolve(dirname(manifestPath), path)));
    await page.waitForFunction(
      (count) => document.querySelectorAll(".poc-attachments img").length === count,
      round.photos.length,
    );
    assert.equal(await page.locator(".poc-attachments img").count(), round.photos.length);
    timings.push({ id: round.id, uploadAndReplyMs: await send() });
    const current = await snapshot();
    for (const kind of round.expect.kinds ?? [])
      assert.ok(
        current.installation.equipment.some((item) => item.kind === kind),
        `${round.id}: ${kind}`,
      );
  }
  let state = await snapshot();
  assert.equal(
    state.installation.equipment.filter((item) => item.kind === "charge-controller").length,
    1,
  );
  assert.equal(
    state.installation.equipment.find((item) => item.kind === "charge-controller").model,
    "XTRA4210N",
  );
  assert.equal(state.installation.equipment.find((item) => item.kind === "battery").quantity, 6);
  assert.equal(state.installation.facts.length, 0);
  assert.equal(state.messages.length, 7);
  await page.screenshot({ path: resolve(output, "desktop.png"), animations: "disabled" });
  if (initial.mode === "live") {
    await page
      .getByRole("textbox", { name: "Message Buddy" })
      .fill("How many batteries did I tell you I have?");
    timings.push({ id: "contextual-chat", uploadAndReplyMs: await send() });
    assert.match(await page.locator(".poc-messages .is-assistant").last().innerText(), /six|6/i);
    await page
      .getByRole("textbox", { name: "Message Buddy" })
      .fill("Forget the setup. Plan a beach vacation for me.");
    timings.push({ id: "app-referral", uploadAndReplyMs: await send() });
    assert.match(
      await page.locator(".poc-messages .is-assistant").last().innerText(),
      /app preview/i,
    );
    assert.equal(
      await page.getByRole("link", { name: "Explore the app" }).getAttribute("href"),
      "/app/",
    );
  }
  state = await snapshot();
  const battery = state.installation.equipment.find((item) => item.kind === "battery");
  await page.getByRole("button", { name: `Review ${battery.name}`, exact: true }).click();
  await page.getByLabel("Equipment name", { exact: true }).fill("My cottage battery bank");
  await page.getByRole("button", { name: "Confirm these details" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.reload({ waitUntil: "load" });
  await page.getByRole("button", { name: "Review My cottage battery bank", exact: true }).waitFor();
  state = await snapshot();
  assert.equal(state.installation.equipment.find((item) => item.id === battery.id).confirmed, true);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .locator(".poc-header")
      .getByRole("button", { name: "Download setup record", exact: true })
      .click(),
  ]);
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.installation.equipment.find((item) => item.id === battery.id).quantity, 6);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${width}px: overflow`,
    );
    await page.getByRole("button", { name: "Your map", exact: true }).click();
    assert.equal(await page.locator(".poc-map").isVisible(), true);
    assert.equal(await page.locator(".poc-chat").isVisible(), false);
    await page.screenshot({ path: resolve(output, `map-${width}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Chat with Buddy", exact: true }).click();
    await page.screenshot({ path: resolve(output, `chat-${width}.png`), animations: "disabled" });
  }
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Keep this setup" })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await page.getByRole("button", { name: "Delete and start again" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".poc-messages .is-assistant").length === 1,
  );
  assert.equal((await snapshot()).installation.equipment.length, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "verification.json"),
    JSON.stringify(
      {
        mode: initial.mode,
        timings,
        errors,
        checks: [
          "progressive real uploads",
          "inventory and no duplicate MPPT",
          "context and app referral when live",
          "review and refresh persistence",
          "JSON export",
          "390/320px views",
          "reset keyboard focus and deletion",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, mode: initial.mode, timings, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  await writeFile(
    resolve(output, "failure.json"),
    JSON.stringify(
      {
        message: error.message,
        timings,
        errors,
        text: await page
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
  await browser.close();
}
