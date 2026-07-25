import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const RUNTIME_ENTRIES = Object.freeze([
  "manifest.json",
  "background.js",
  "background",
  "shared",
  "sidepanel",
  "icons",
]);

const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".next",
  "node_modules",
  "mcp-server",
  "website",
]);

const FORBIDDEN_FILE_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /\.map$/i,
  /\.(?:pem|p12|pfx|key)$/i,
  /(^|\/)\.DS_Store$/,
];

const SOURCE_ONLY_FILES = new Set([
  "icons/icon.svg",
]);

function assertSafeRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    segments.includes("..") ||
    segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) ||
    FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new Error(`Forbidden release path: ${relativePath}`);
  }
}

async function walk(rootDir, relativePath, files) {
  assertSafeRelativePath(relativePath);
  const normalizedPath = relativePath.split(path.sep).join("/");
  if (SOURCE_ONLY_FILES.has(normalizedPath)) return;
  const absolutePath = path.join(rootDir, relativePath);
  const stat = await lstat(absolutePath);

  if (stat.isSymbolicLink()) {
    throw new Error(`Symlinks are not allowed in the extension package: ${relativePath}`);
  }
  if (stat.isFile()) {
    files.push(relativePath.split(path.sep).join("/"));
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Unsupported release entry: ${relativePath}`);
  }

  const children = await readdir(absolutePath);
  children.sort((a, b) => a.localeCompare(b));
  for (const child of children) {
    await walk(rootDir, path.join(relativePath, child), files);
  }
}

export async function collectRuntimeFiles(rootDir) {
  const files = [];
  for (const entry of RUNTIME_ENTRIES) {
    await walk(rootDir, entry, files);
  }
  return files.sort((a, b) => a.localeCompare(b));
}
