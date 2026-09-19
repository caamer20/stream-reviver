import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installProtocolBridge } from "../../src/page-bridge/bridge";

test("serialized MAIN-world bridge rejects a sibling port before touching page APIs", () => {
  const scope = { location: { origin: "https://example.com:9090" } };
  // No window object: reaching any page instrumentation would throw.
  vm.runInNewContext(`(${installProtocolBridge.toString()})("https://example.com:8080")`, scope);
});

test("serialized MAIN-world bridge initializes only once on its authorized origin", () => {
  let intervals = 0;
  const page = { setInterval: () => { intervals += 1; }, postMessage: () => undefined };
  const scope = vm.createContext({ location: { origin: "https://example.com:8080" }, window: page });
  const invocation = `(${installProtocolBridge.toString()})("https://example.com:8080")`;
  vm.runInContext(invocation, scope);
  vm.runInContext(invocation, scope);
  assert.equal(intervals, 1);
  assert.equal((page as any).__streamReviverProtocolBridgeV3, true);
});
