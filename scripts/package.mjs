import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
const artifacts = path.join(root, "artifacts");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const archiveSpecs = [
  { name: `stream-reviver-${version}-chrome.zip`, directory: "dist/stable/chrome", prefix: "" },
  { name: `stream-reviver-${version}-firefox.zip`, directory: "dist/stable/firefox", prefix: "" },
  { name: `stream-reviver-${version}-source.zip`, directory: ".", prefix: `stream-reviver-${version}/`, source: true }
];
const releases = {};
for (const spec of archiveSpecs) {
  const entries = await collect(spec.directory, spec.source === true);
  const bytes = createZip(entries.map((entry) => ({ ...entry, name: `${spec.prefix}${entry.name}` })));
  const destination = path.join(artifacts, spec.name);
  await writeFile(destination, bytes);
  releases[spec.name] = { bytes: bytes.length, sha256: sha256(bytes) };
}

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const components = Object.entries(lock.packages ?? {}).filter(([key]) => key.startsWith("node_modules/")).map(([key, value]) => ({
  type: "library", name: key.slice("node_modules/".length), version: value.version ?? "unknown", scope: "development",
  purl: value.version ? `pkg:npm/${encodeURIComponent(key.slice("node_modules/".length))}@${value.version}` : undefined
})).sort((a, b) => a.name.localeCompare(b.name));
const sbom = { bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { component: { type: "application", name: packageJson.name, version } }, components };
const sbomName = `stream-reviver-${version}-sbom.cdx.json`;
const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(path.join(artifacts, sbomName), sbomBytes);
await writeFile(path.join(artifacts, "release-manifest.json"), `${JSON.stringify({
  version, channel: "stable", archives: releases, sbom: { name: sbomName, bytes: sbomBytes.length, sha256: sha256(sbomBytes) }
}, null, 2)}\n`);
console.log(`Created deterministic Chrome, Firefox, and source archives in ${path.relative(root, artifacts)}.`);

async function collect(directory, sourceArchive) {
  const base = path.resolve(directory);
  const files = [];
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name);
      const relative = path.relative(base, file).replaceAll(path.sep, "/");
      if (sourceArchive && excluded(relative)) continue;
      const info = await stat(file);
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) files.push({ name: relative, data: await readFile(file) });
    }
  }
  await visit(base);
  return files;
}
function excluded(relative) {
  const first = relative.split("/")[0];
  return [".git", ".test-dist", "artifacts", "dist", "node_modules", "web-ext-artifacts"].includes(first) || relative.endsWith(".zip") || relative === ".DS_Store";
}
function createZip(entries) {
  const localParts = []; const centralParts = []; let offset = 0;
  const time = 0; const date = (40 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const crc = crc32(entry.data); const size = entry.data.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42); centralParts.push(central, name);
    offset += local.length + name.length + size;
  }
  const centralDirectory = Buffer.concat(centralParts); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
