import assert from "node:assert/strict";
import { createDeterministicZip } from "./deterministic-zip.mjs";

const entries = [
  { name: "script.sh", mode: "100755", data: Buffer.from("#!/bin/sh\n") },
  { name: "manifest.json", mode: "100644", data: Buffer.from("{}\n") }
];
const first = createDeterministicZip(entries);
const second = createDeterministicZip([...entries].reverse());
assert.ok(first.equals(second), "entry order must not affect archive bytes");

const records = centralRecords(first);
assert.deepEqual(records.map((record) => record.name), ["manifest.json", "script.sh"]);
assert.equal(records[0].versionMadeBy, 0x0314, "central record must declare Unix origin");
assert.equal(records[0].unixMode, 0o100644, "regular file mode must be preserved in external attributes");
assert.equal(records[1].unixMode, 0o100755, "executable file mode must be preserved without signed overflow");
assert.throws(() => createDeterministicZip([...entries, entries[0]]), /unique/);
assert.throws(() => createDeterministicZip([{ name: "../escape", data: Buffer.alloc(0) }]), /not normalized|escapes/);
assert.throws(() => createDeterministicZip([{ name: "link", mode: "120000", data: Buffer.alloc(0) }]), /unsafe mode/);

console.log("Deterministic ZIP tests passed.");

function centralRecords(bytes) {
  const records = [];
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    records.push({
      name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
      versionMadeBy: bytes.readUInt16LE(offset + 4),
      unixMode: bytes.readUInt32LE(offset + 38) >>> 16
    });
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return records;
}
