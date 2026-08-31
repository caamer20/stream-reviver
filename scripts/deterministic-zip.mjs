import assert from "node:assert/strict";
import { validateArchivePath } from "./release-integrity.mjs";

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const DOS_EPOCH_DATE = (40 << 9) | (1 << 5) | 1;
const SAFE_MODES = new Set(["100644", "100755"]);

/**
 * Create a deterministic, uncompressed ZIP32 archive.
 *
 * Store releases are deliberately small, so rejecting ZIP64-sized input is
 * safer than emitting an archive whose offsets or sizes silently wrap. Entry
 * names are UTF-8, sorted, unique, normalized, and contain no directory or
 * symlink records.
 */
export function createDeterministicZip(inputEntries) {
  assert.ok(Array.isArray(inputEntries), "ZIP entries must be an array");
  assert.ok(inputEntries.length <= MAX_UINT16, "ZIP64 is not supported; too many archive entries");

  const entries = [...inputEntries].sort((first, second) => first.name.localeCompare(second.name));
  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    validateArchivePath(entry.name);
    assert.ok(!entry.name.endsWith("/"), `ZIP directory entries are not supported: ${entry.name}`);
    assert.ok(!names.has(entry.name), `ZIP entry names must be unique: ${entry.name}`);
    names.add(entry.name);
    assert.ok(Buffer.isBuffer(entry.data), `ZIP entry data must be a Buffer: ${entry.name}`);
    assert.ok(SAFE_MODES.has(entry.mode ?? "100644"), `ZIP entry has an unsafe mode: ${entry.name}`);

    const name = Buffer.from(entry.name, "utf8");
    const size = entry.data.length;
    assert.ok(name.length <= MAX_UINT16, `ZIP entry name is too long: ${entry.name}`);
    assert.ok(size <= MAX_UINT32, `ZIP64 is not supported; entry is too large: ${entry.name}`);
    assert.ok(offset <= MAX_UINT32, "ZIP64 is not supported; local-header offset is too large");

    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const unixMode = entry.mode === "100755" ? 0o100755 : 0o100644;
    central.writeUInt32LE((unixMode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + size;
    assert.ok(offset <= MAX_UINT32, "ZIP64 is not supported; archive data is too large");
  }

  const centralDirectory = Buffer.concat(centralParts);
  assert.ok(centralDirectory.length <= MAX_UINT32, "ZIP64 is not supported; central directory is too large");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
