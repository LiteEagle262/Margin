import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { collectRuntimeFiles } from "./release-files.mjs";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
// 2000-01-01T00:00:00 in MS-DOS date/time, so archives are byte-identical between builds.
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, contents } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(contents, { level: 9 });
    const compressed = deflated.length < contents.length;
    const payload = compressed ? deflated : contents;
    const checksum = crc32(contents);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBytes, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(compressed ? 8 : 0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(contents.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);

    offset += header.length + nameBytes.length + payload.length;
  }

  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

function listZipEntryNames(archive) {
  let cursor = archive.length - 22;
  while (cursor >= 0 && archive.readUInt32LE(cursor) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    cursor -= 1;
  }
  if (cursor < 0) throw new Error("Generated ZIP has no end-of-central-directory record");

  const count = archive.readUInt16LE(cursor + 10);
  let record = archive.readUInt32LE(cursor + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(record) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("Generated ZIP central directory is corrupt");
    }
    const nameLength = archive.readUInt16LE(record + 28);
    const extraLength = archive.readUInt16LE(record + 30);
    const commentLength = archive.readUInt16LE(record + 32);
    names.push(archive.toString("utf8", record + 46, record + 46 + nameLength));
    record += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8"));
const runtimeFiles = await collectRuntimeFiles(rootDir);
const distDir = path.join(rootDir, "dist");
const zipName = `margin-extension-v${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);

const files = await Promise.all(
  runtimeFiles.map(async (name) => ({ name, contents: await readFile(path.join(rootDir, name)) })),
);

await mkdir(distDir, { recursive: true });
await rm(zipPath, { force: true });
await writeFile(zipPath, buildZip(files));

const archive = await readFile(zipPath);
const packagedFiles = listZipEntryNames(archive).sort((a, b) => a.localeCompare(b));
const expectedFiles = [...runtimeFiles].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(packagedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Generated ZIP contents do not match the extension runtime allowlist");
}

const digest = createHash("sha256").update(archive).digest("hex");
console.log(`Created dist/${zipName}`);
console.log(`Files: ${runtimeFiles.length} | Bytes: ${archive.length} | SHA-256: ${digest}`);
