import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyBundle } from "./catalogue-release.mjs";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3)
  throw new Error("Usage: node scripts/catalogue-release-summary.mjs bundle-directory");
const release = await verifyBundle(directory);
const rows = [];
for (const entry of release.manifest.catalogues) {
  const report = JSON.parse(await readFile(join(directory, entry.id, "report.json"), "utf8"));
  rows.push(
    `| ${entry.id} | ${entry.records} | ${report.rejected?.length ?? 0} | ${report.conflicts?.length ?? 0} |`,
  );
}
const summary = `## Catalogue ready for review\n\nSource commit: \`${release.manifest.commit}\`\n\nApproved digest: \`${release.digest}\`\n\n| Catalogue | Accepted records | Quarantined | Conflicts |\n|---|---:|---:|---:|\n${rows.join("\n")}\n\nDownload the artifact to review the full reports and records. This build has not published any data. To publish these exact bytes, run the workflow at the same commit with Publish enabled and this digest.\n`;
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, `digest=${release.digest}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);
