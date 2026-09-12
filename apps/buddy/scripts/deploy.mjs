import { execFileSync } from "node:child_process";

const options = { cwd: new URL("../", import.meta.url), stdio: "inherit" };
const config = ["--config", "wrangler.deploy.json", "--remote", "--experimental-provision=false"];
execFileSync(
  "pnpm",
  ["exec", "wrangler", "d1", "migrations", "apply", "KNOWLEDGE", ...config],
  options,
);
const output = execFileSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "KNOWLEDGE",
    ...config,
    "--json",
    "--command",
    "SELECT c.id, COUNT(r.id) AS records FROM knowledge_catalogues c JOIN knowledge_records r ON r.catalogue_id=c.id AND r.catalogue_revision=c.active_revision AND r.status='verified' GROUP BY c.id",
  ],
  { ...options, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
);
const rows = JSON.parse(output)[0]?.results ?? [];
for (const id of ["sam-cec", "manufacturer-specifications", "cec-batteries", "reviewed-equipment"])
  if (!rows.some((row) => row.id === id && row.records > 0))
    throw new Error(`Publish the catalogue first: ${id}`);
execFileSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.deploy.json",
    "--experimental-provision=false",
  ],
  options,
);
