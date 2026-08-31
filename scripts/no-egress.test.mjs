import assert from "node:assert/strict";
import { assertNoEgressInHtml, assertNoEgressInSource, inspectNoEgress } from "./no-egress.mjs";

const forbidden = [
  ["fetch", `fetch(dynamicUrl)`],
  ["fetch alias", `const request = globalThis.fetch; request(dynamicUrl)`],
  ["XHR", `const xhr = new XMLHttpRequest(); xhr.open("GET", dynamicUrl)`],
  ["EventSource", `new EventSource(dynamicUrl)`],
  ["WebSocket", `const Socket = window.WebSocket; new Socket(dynamicUrl)`],
  ["beacon", `navigator.sendBeacon(dynamicUrl, payload)`],
  ["image URL", `const pixel = new Image(); pixel.src = dynamicUrl`],
  ["inline image URL", `document.createElement("img").src = "https://tracker.invalid/pixel"`],
  ["image attribute", `const pixel = document.createElement("img"); pixel.setAttribute("src", dynamicUrl)`],
  ["form action", `const form = document.createElement("form"); form.action = dynamicUrl`],
  ["form submit", `document.querySelector("form").requestSubmit()`],
  ["location href", `window.location.href = dynamicUrl`],
  ["location replace", `location.replace(dynamicUrl)`],
  ["window open", `window.open(dynamicUrl)`]
];

for (const [label, source] of forbidden) {
  const findings = inspectNoEgress(source, `${label}.js`);
  assert.ok(findings.length > 0, `${label} fixture must be rejected`);
  assert.throws(() => assertNoEgressInSource(source, `${label}.js`), /forbidden outbound-network\/navigation capability/);
}

for (const [label, source] of [
  ["extension page", `const url = chrome.runtime.getURL("options.html"); window.history.replaceState({}, "", url)`],
  ["blob download", `const link = document.createElement("a"); const url = URL.createObjectURL(new Blob(["safe"])); link.href = url; link.click()`],
  ["data image", `const image = new Image(); image.src = "data:image/png;base64,AAAA"; image.decode()`],
  ["ordinary DOM", `const button = document.createElement("button"); button.addEventListener("click", handler)`],
  ["reload", `window.location.reload()`]
]) assert.doesNotThrow(() => assertNoEgressInSource(source, `${label}.js`), `${label} fixture must remain allowed`);

assert.doesNotThrow(() => assertNoEgressInSource(
  `async function visualHash(dataUrl) { const image = new Image(); image.src = dataUrl; await image.decode(); }`,
  "content.js",
  { localDataImageParameters: { visualHash: ["dataUrl"] } }
));
assert.throws(() => assertNoEgressInSource(
  `async function other(dataUrl) { const image = new Image(); image.src = dataUrl; }`,
  "content.js",
  { localDataImageParameters: { visualHash: ["dataUrl"] } }
), /element-url/);
assert.doesNotThrow(() => assertNoEgressInSource(
  `function executeRecovery(backup) { button.onclick = () => location.assign(backup); }`,
  "content.js",
  { userNavigationIdentifiers: { executeRecovery: ["backup"] } }
));
assert.throws(() => assertNoEgressInSource(
  `function other(backup) { location.assign(backup); }`,
  "content.js",
  { userNavigationIdentifiers: { executeRecovery: ["backup"] } }
), /location-navigation/);

assert.throws(() => assertNoEgressInHtml(`<form action="https://tracker.invalid/"></form>`, "bad.html"), /remote HTML egress/);
assert.throws(() => assertNoEgressInHtml(`<img src="//tracker.invalid/pixel">`, "bad.html"), /remote HTML egress/);
assert.doesNotThrow(() => assertNoEgressInHtml(`<link rel="stylesheet" href="popup.css"><form></form>`, "safe.html"));

console.log(`No-egress AST tests passed (${forbidden.length} negative JavaScript fixtures).`);
