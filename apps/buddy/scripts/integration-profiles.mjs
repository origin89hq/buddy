import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { integrationSchema, knowledgeRecordSchema } from "../src/knowledge.ts";
import { sha } from "./manufacturer-adapters.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export async function loadIntegrationProfiles(
  evidenceRoot = join(root, "apps/buddy/knowledge/evidence"),
) {
  const profiles = JSON.parse(
    await readFile(join(root, "apps/buddy/knowledge/integration-profiles.json"), "utf8"),
  );
  const manifest = JSON.parse(await readFile(join(evidenceRoot, "manifest.json"), "utf8"));
  const checked = new Set();
  for (const [name, profile] of Object.entries(profiles)) {
    integrationSchema.parse(profile);
    let verified = 0;
    for (const evidence of profile.evidence) {
      if (!/^(docs|crates)\/[a-zA-Z0-9/_.-]+$/.test(evidence.path) || evidence.path.includes(".."))
        throw new Error("Invalid evidence path");
      // Cited, not carried. Reading it would fail here and skipping it quietly
      // would let a profile drift until nothing was compared at all, so it is
      // counted as provenance and the profile still has to prove something.
      if (evidence.external) continue;
      verified += 1;
      const key = `${evidence.path}:${evidence.sha256}`;
      if (checked.has(key)) continue;
      const pinned = manifest.files[evidence.path];
      if (!pinned || pinned.sha256 !== evidence.sha256 || !/^[a-z0-9-]+\.rs$/.test(pinned.archive))
        throw new Error(`Missing pinned controller evidence: ${evidence.path}`);
      if (sha(await readFile(join(evidenceRoot, pinned.archive))) !== evidence.sha256)
        throw new Error(
          `Integration evidence changed; review before publication: ${evidence.path}`,
        );
      checked.add(key);
    }
    if (!verified)
      throw new Error(
        `Every evidence entry for ${name} is external, so this profile checks nothing`,
      );
  }
  return profiles;
}

export function integrationFor(record, profiles) {
  const chemistry = record.specifications.find((s) => s.name === "Chemistry")?.value;
  const key =
    record.kind === "battery" && typeof chemistry === "string" && /lead-acid/i.test(chemistry)
      ? "passive-lead-acid"
      : record.brand === "Victron Energy" && /^SmartShunt (300|500|1000|2000)A$/.test(record.model)
        ? "smartshunt"
        : record.brand === "Peacefair" && record.model === "PZEM-017"
          ? "pzem-017"
          : record.brand === "EPEVER" &&
              record.kind === "inverter" &&
              /^IP\d+-\d+(?:-Plus)?$/.test(record.model) &&
              (record.model.endsWith("-Plus") || /^IP(?:1000|1500|2000)-/.test(record.model))
            ? "epever-ipower"
            : record.brand === "EPEVER" && record.model === "XTRA4210N"
              ? "epever-xtra4210n"
              : null;
  return key ? knowledgeRecordSchema.parse({ ...record, integration: profiles[key] }) : record;
}
