import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball) throw new Error("Pass the package tarball to check.");
const consumer = await mkdtemp(join(tmpdir(), "buddy-package-"));
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      resolve(tarball),
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  await copyFile(new URL("./package-consumer.mjs", import.meta.url), join(consumer, "check.mjs"));
  execFileSync(process.execPath, ["check.mjs"], { cwd: consumer, stdio: "inherit" });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
