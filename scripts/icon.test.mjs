import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { createIconPng } from "./icon.mjs";

const fixtures = new Map([
  [16, "554689e04f48b12dd5f3d5f3199cedf5944381093967426583ec33a8a37d8060"],
  [32, "b0fc221a90328c6fa3db2d4a5c2b666ca6b3ce416077df70232cc0cbd14be6fa"],
  [48, "47d696a1ead337f11a40abbae327cace1ea11b426f4c9fba846b82c07c87b363"],
  [128, "9b8e9406069400172803953202bb59c6006e428b1f252ca4b71102a4222b7d21"]
]);
for (const [size, hash] of fixtures) {
  const png = createIconPng(size);
  assert.equal(createHash("sha256").update(png).digest("hex"), hash, `${size}px icon must be byte-identical on every platform`);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  assert.equal(raw.length, size * (size * 4 + 1));
  for (let y = 0; y < size; y++) assert.equal(raw[y * (size * 4 + 1)], 0, "PNG scanline uses no filter");
}
for (const size of [0, 15, 513, 32.5, NaN]) assert.throws(() => createIconPng(size), TypeError);
console.log("Icon golden-byte and PNG/zlib decoding checks passed for all shipped sizes.");
