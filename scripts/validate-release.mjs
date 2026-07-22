import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRuntimeFiles } from "./release-files.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(relativePath) {
  const raw = await readFile(path.join(rootDir, relativePath), "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function flattenManifestAssetPaths(manifest) {
  return [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);
}

async function validateManifest(manifest, packageJson, runtimeFiles) {
  const forbiddenOptionalPermissions = new Set([
    "debugger",
    "declarativeNetRequest",
    "devtools",
    "geolocation",
    "mdns",
    "proxy",
    "tts",
    "ttsEngine",
    "wallpaper",
  ]);
  assert(manifest.manifest_version === 3, "manifest.json must use Manifest V3");
  assert(manifest.name === "Margin", 'manifest.json name must be "Margin"');
  assert(typeof manifest.description === "string" && manifest.description.length > 0, "Manifest description is required");
  assert(manifest.description.length <= 132, "Manifest description exceeds Chrome's 132-character limit");
  assert(/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version || ""), "Manifest version must contain one to four numeric components");
  assert(packageJson.version === manifest.version, "package.json and manifest.json versions must match");
  assert(manifest.background?.type === "module", "Background service worker must be an ES module");
  assert(manifest.permissions?.includes("debugger"), 'Chrome requires "debugger" in permissions, not optional_permissions');
  for (const permission of manifest.optional_permissions || []) {
    assert(!forbiddenOptionalPermissions.has(permission), `Chrome rejects "${permission}" in optional_permissions`);
  }
  assert(manifest.content_security_policy?.extension_pages, "Extension-page CSP is required");
  assert(!/unsafe-eval|https?:/i.test(manifest.content_security_policy.extension_pages), "Extension CSP must not allow unsafe-eval or remote script sources");

  const runtimeSet = new Set(runtimeFiles);
  for (const assetPath of flattenManifestAssetPaths(manifest)) {
    const normalized = String(assetPath).replace(/^\//, "");
    assert(runtimeSet.has(normalized), `Manifest asset is missing from the release allowlist: ${assetPath}`);
    await access(path.join(rootDir, normalized));
  }

  const icon128 = manifest.icons?.["128"];
  assert(icon128, "A 128px extension icon is required");
  assert(manifest.side_panel?.default_path, "A side panel entry point is required");
}

async function validateIconDimensions(manifest) {
  for (const [declaredSize, relativePath] of Object.entries(manifest.icons || {})) {
    if (!relativePath.toLowerCase().endsWith(".png")) continue;
    const png = await readFile(path.join(rootDir, relativePath));
    const expectedSignature = "89504e470d0a1a0a";
    assert(png.subarray(0, 8).toString("hex") === expectedSignature, `${relativePath} is not a valid PNG`);
    const expectedSize = Number(declaredSize);
    assert(
      png.readUInt32BE(16) === expectedSize && png.readUInt32BE(20) === expectedSize,
      `${relativePath} must be ${expectedSize}x${expectedSize}px`,
    );
  }
}

async function validateRuntimeSource(runtimeFiles) {
  const textFiles = runtimeFiles.filter((file) => /\.(?:html|js|css|json|svg)$/i.test(file));
  const retiredRuntimeStrings = [
    "codex-bridge",
    "margin-cli serve --mode codex",
    "ws://127.0.0.1:9230",
    "ScrapeFlow",
  ];
  for (const relativePath of textFiles) {
    const source = await readFile(path.join(rootDir, relativePath), "utf8");
    assert(!/<script\b[^>]*\bsrc=["']https?:/i.test(source), `Remote script found in ${relativePath}`);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source), `Private key material found in ${relativePath}`);
    assert(!/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/.test(source), `Possible live API key found in ${relativePath}`);
    for (const retired of retiredRuntimeStrings) {
      assert(!source.includes(retired), `Retired runtime string "${retired}" found in ${relativePath}`);
    }
  }
}

async function validateRequiredProjectFiles() {
  const required = ["LICENSE"];
  await Promise.all(required.map((relativePath) => access(path.join(rootDir, relativePath))));
}

export async function validateRelease() {
  const [manifest, packageJson, runtimeFiles] = await Promise.all([
    readJson("manifest.json"),
    readJson("package.json"),
    collectRuntimeFiles(rootDir),
  ]);

  await validateManifest(manifest, packageJson, runtimeFiles);
  await validateIconDimensions(manifest);
  await validateRuntimeSource(runtimeFiles);
  await validateRequiredProjectFiles();
  return { manifest, runtimeFiles };
}

try {
  const { manifest, runtimeFiles } = await validateRelease();
  console.log(`Release validation passed for Margin ${manifest.version} (${runtimeFiles.length} runtime files).`);
} catch (error) {
  console.error(`Release validation failed: ${error.message}`);
  process.exitCode = 1;
}
