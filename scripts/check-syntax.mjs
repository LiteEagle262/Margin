import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRuntimeFiles } from "./release-files.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeFiles = await collectRuntimeFiles(rootDir);
const jsFiles = runtimeFiles.filter((file) => file.endsWith(".js"));

for (const relativePath of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", relativePath], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${relativePath}\n`);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed for ${jsFiles.length} extension modules.`);
