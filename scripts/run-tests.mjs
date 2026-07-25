import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = await readdir(path.join(rootDir, "tests"));
const testFiles = entries
  .filter((name) => name.endsWith(".test.mjs"))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => `tests/${name}`);

if (testFiles.length === 0) {
  console.error("No test files matched tests/*.test.mjs.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
