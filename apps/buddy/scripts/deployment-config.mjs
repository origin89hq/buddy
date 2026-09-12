import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const namePattern = /^[a-z][a-z0-9-]{0,62}$/;

function reader(env) {
  return (key, pattern) => {
    const value = env[key];
    if (typeof value !== "string" || !pattern.test(value))
      throw new Error(`Missing or invalid ${key}`);
    return value;
  };
}

/** Buddy: every binding it needs, and no way in from outside. */
export function buddyConfig(base, env) {
  const requireValue = reader(env);
  const account = requireValue("CLOUDFLARE_ACCOUNT_ID", /^[a-f0-9]{32}$/);
  const database = requireValue(
    "BUDDY_DATABASE_ID",
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  );
  const bucket = requireValue("BUDDY_PHOTOS_BUCKET", /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  const name = requireValue("BUDDY_WORKER_NAME", namePattern);
  const config = structuredClone(base);
  delete config.env;
  // OpenAI handles the production setup and chat models. Keep Workers AI only
  // when a Cloudflare model is explicitly selected, as in the separate harness.
  if (
    config.vars?.BUDDY_MODEL?.startsWith("openai/") &&
    config.vars?.BUDDY_CHAT_MODEL?.startsWith("openai/")
  )
    delete config.ai;
  return {
    ...config,
    name,
    account_id: account,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: "KNOWLEDGE",
        database_name: "origin89-equipment-knowledge",
        database_id: database,
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [{ binding: "PHOTOS", bucket_name: bucket }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = [];
  const base = parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"), errors);
  if (errors.length) throw new Error("Invalid Wrangler config");
  const config = buddyConfig(base, process.env);
  await writeFile(
    new URL("../wrangler.deploy.json", import.meta.url),
    JSON.stringify(config, null, 2) + "\n",
  );
  console.log(`Prepared ${config.name}; no resources created or deployed.`);
}
