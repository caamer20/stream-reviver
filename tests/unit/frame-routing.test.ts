import test from "node:test";
import assert from "node:assert/strict";
import { frameIdsForOrigin } from "../../src/background/frame-routing";

test("origin routing never leaks settings or shutdown messages into sibling frames", () => {
  const frames = new Map([
    [0, { origin: "https://host.example" }],
    [4, { origin: "https://player.example" }],
    [7, { origin: "https://ads.example" }],
    [9, { origin: "https://player.example" }]
  ]);
  assert.deepEqual(frameIdsForOrigin(frames, "https://player.example", "https://host.example"), [4, 9]);
  assert.deepEqual(frameIdsForOrigin(frames, "https://host.example", "https://host.example"), [0]);
  assert.deepEqual(frameIdsForOrigin(frames, "https://ads.example", "https://host.example"), [7]);
});

test("the top frame can be routed before its first status report", () => {
  assert.deepEqual(frameIdsForOrigin(undefined, "https://host.example", "https://host.example"), [0]);
  assert.deepEqual(frameIdsForOrigin(undefined, "https://player.example", "https://host.example"), []);
});
