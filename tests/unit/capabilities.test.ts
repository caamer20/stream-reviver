import test from "node:test";
import assert from "node:assert/strict";
import { decideMediaReload, inferPlayerType, stableSourceFingerprint, type MediaCapabilityProbe } from "../../src/shared/capabilities";

const base: MediaCapabilityProbe = {
  declaredPlayerType: "AUTO", protocolKind: null, hasVideo: true, hasCanvasTarget: false,
  hasSrcObject: false, currentSource: "https://media.example/live.m3u8?token=secret#fragment"
};

test("declared player type has precedence", () => assert.equal(inferPlayerType({ ...base, declaredPlayerType: "DASH_JS", protocolKind: "MSE" }), "DASH_JS"));
test("protocol bridge identifies a managed player", () => assert.equal(inferPlayerType({ ...base, protocolKind: "HLS_JS" }), "HLS_JS"));
test("srcObject is conservatively treated as WebRTC", () => assert.equal(inferPlayerType({ ...base, hasSrcObject: true }), "WEBRTC"));
test("accessible native video defaults to HTML5", () => assert.equal(inferPlayerType(base), "HTML5"));
test("canvas-only target is reported as canvas", () => assert.equal(inferPlayerType({ ...base, hasVideo: false, hasCanvasTarget: true }), "CANVAS"));

test("native URL-backed HTML media can reload", () => assert.equal(decideMediaReload("HTML5", base).safe, true));
for (const type of ["MSE", "HLS_JS", "DASH_JS", "WEBRTC", "CANVAS"] as const) {
  test(`${type} media reload is denied without an adapter`, () => assert.equal(decideMediaReload(type, base).safe, false));
}
test("blob-backed HTML media reload is denied conservatively", () => assert.equal(decideMediaReload("HTML5", { ...base, currentSource: "blob:https://example.com/id" }).safe, false));
test("source fingerprints remove query strings and fragments", () => assert.equal(stableSourceFingerprint(base.currentSource), "https://media.example/live.m3u8"));
