import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("apps/buddy/package.json", root));
const { parse } = require("jsonc-parser");
const fixture = new URL("packages/buddy/fixture/", root);
await mkdir(fixture, { recursive: true });
execFileSync(
  "pnpm",
  [
    "--filter",
    "origin89-buddy",
    "exec",
    "wrangler",
    "deploy",
    "--env",
    "fixture",
    "--dry-run",
    "--outdir",
    "../../packages/buddy/fixture",
  ],
  { cwd: root, stdio: "inherit" },
);
const base = parse(await readFile(new URL("apps/buddy/wrangler.jsonc", root), "utf8"));
const config = {
  ...base,
  ...base.env.fixture,
  name: "origin89-buddy-poc-fixture",
  main: "./index.js",
  workers_dev: false,
  preview_urls: false,
};
delete config.env;
delete config.ai;
delete config.$schema;
config.d1_databases[0].migrations_dir = "./migrations";
await cp(new URL("apps/buddy/migrations/", root), new URL("migrations/", fixture), {
  recursive: true,
});
await writeFile(
  new URL("wrangler.jsonc", fixture),
  JSON.stringify(
    {
      ...config,
      name: "origin89-buddy-poc",
      env: { fixture: { ...config, name: "origin89-buddy-poc-fixture" } },
    },
    null,
    2,
  ) + "\n",
);
await mkdir(new URL("dist/", root), { recursive: true });
execFileSync("pnpm", ["--filter", "@origin89/buddy", "pack", "--pack-destination", "dist"], {
  cwd: root,
  stdio: "inherit",
});
