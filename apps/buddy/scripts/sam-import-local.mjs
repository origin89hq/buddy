import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCecBatteries } from "./cec-batteries.mjs";
import { buildManufacturers } from "./manufacturer-catalogue.mjs";
import { buildSam } from "./sam-catalogue.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const wrangler = join(appRoot, "node_modules/wrangler/bin/wrangler.js");
const database = "origin89-equipment-knowledge";
// Deliberately local-only. This command cannot provision or seed a remote account.
async function run(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: appRoot,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: "/tmp/origin89-catalogue-wrangler.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0)
    throw new Error(`Local D1 import failed (${code}): ${stderr || stdout.slice(-4000)}`);
  return stdout;
}

const args = process.argv.slice(2);
if (
  args.some((arg) => !["--offline", "--manufacturers", "--cec-batteries"].includes(arg)) ||
  (args.includes("--manufacturers") && args.includes("--cec-batteries"))
)
  throw new Error(
    "Usage: node scripts/sam-import-local.mjs [--offline] [--manufacturers | --cec-batteries]",
  );
const manufacturers = args.includes("--manufacturers");
const cecBatteries = args.includes("--cec-batteries");
const built = manufacturers
  ? await buildManufacturers()
  : cecBatteries
    ? await buildCecBatteries({ offline: args.includes("--offline") })
    : await buildSam({ offline: args.includes("--offline") });
const catalogueId = manufacturers
  ? "manufacturer-specifications"
  : cecBatteries
    ? "cec-batteries"
    : "sam-cec";
console.log(JSON.stringify({ event: "catalogue_built", ...built }));
await run(["d1", "migrations", "apply", database, "--local"]);
const plan = JSON.parse(await readFile(join(built.directory, "import.json"), "utf8"));
for (let index = 0; index < plan.files.length; index++) {
  const file = plan.files[index];
  if (!/^(records-\d{4}|activate)\.sql$/.test(file)) throw new Error("Unexpected import file");
  await run([
    "d1",
    "execute",
    database,
    "--local",
    "--file",
    join(built.directory, file),
    "--json",
  ]);
  if ((index + 1) % 10 === 0 || index === plan.files.length - 1)
    console.log(
      JSON.stringify({
        event: "catalogue_import_progress",
        completed: index + 1,
        total: plan.files.length,
      }),
    );
}
const check = JSON.parse(
  await run([
    "d1",
    "execute",
    database,
    "--local",
    "--command",
    `SELECT c.active_revision, COUNT(*) AS records FROM knowledge_catalogues c JOIN knowledge_records r ON r.catalogue_id=c.id AND r.catalogue_revision=c.active_revision WHERE c.id='${catalogueId}' AND r.status='verified' GROUP BY c.active_revision`,
    "--json",
  ]),
);
const result = check[0]?.results?.[0];
if (result?.active_revision !== built.revision || result?.records !== built.records)
  throw new Error("Catalogue activation verification failed");
console.log(JSON.stringify({ event: "catalogue_active", ...result }));
