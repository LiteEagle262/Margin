import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRuntimeFiles } from "./release-files.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8"));
const runtimeFiles = await collectRuntimeFiles(rootDir);
const distDir = path.join(rootDir, "dist");
const zipName = `margin-extension-v${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);
const stagingDir = await mkdtemp(path.join(os.tmpdir(), "margin-extension-"));
const normalizedTime = new Date("2000-01-01T00:00:00.000Z");

try {
  for (const relativePath of runtimeFiles) {
    const sourcePath = path.join(rootDir, relativePath);
    const destinationPath = path.join(stagingDir, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, 0o644);
    await utimes(destinationPath, normalizedTime, normalizedTime);
  }

  await mkdir(distDir, { recursive: true });
  await rm(zipPath, { force: true });

  const result = spawnSync("zip", ["-X", "-9", "-q", zipPath, ...runtimeFiles], {
    cwd: stagingDir,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  });
  if (result.error?.code === "ENOENT") {
    throw new Error('The system "zip" command is required to create the Web Store package.');
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `zip exited with status ${result.status}`);
  }

  const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  if (listing.error?.code === "ENOENT") {
    throw new Error('The system "unzip" command is required to verify the Web Store package.');
  }
  if (listing.status !== 0) {
    throw new Error(listing.stderr || listing.stdout || "Could not inspect generated ZIP");
  }
  const packagedFiles = listing.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(packagedFiles) !== JSON.stringify(runtimeFiles)) {
    throw new Error("Generated ZIP contents do not match the extension runtime allowlist");
  }

  const archive = await readFile(zipPath);
  const digest = createHash("sha256").update(archive).digest("hex");
  console.log(`Created dist/${zipName}`);
  console.log(`Files: ${runtimeFiles.length} | Bytes: ${archive.length} | SHA-256: ${digest}`);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
