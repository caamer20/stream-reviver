import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["popup", "options", "welcome"];
for (const page of pages) {
  const html = await readFile(`src/${page}/${page}.html`, "utf8");
  const css = await readFile(`src/${page}/${page}.css`, "utf8");
  assert.match(html, /<html[^>]+lang="en"/, `${page} must declare a document language`);
  assert.match(html, /<meta[^>]+name="viewport"/, `${page} must support zoom and narrow viewports`);
  assert.ok(![...html.matchAll(/<button\b([^>]*)>/g)].some((match) => !/\btype=/.test(match[1])), `${page} has a button without an explicit type`);
  assert.match(css, /:focus-visible|\.skip-link:focus/, `${page} must expose keyboard focus`);
  assert.match(css, /prefers-reduced-motion/, `${page} must honor reduced-motion preferences`);
  assert.match(css, /forced-colors/, `${page} must support forced-color mode`);
}

const popup = await readFile("src/popup/popup.html", "utf8");
assert.match(popup, /aria-live="polite"/, "popup status must be announced without interrupting the user");
assert.match(popup, /role="switch"/, "popup toggles must expose switch semantics");
const options = await readFile("src/options/options.html", "utf8");
assert.match(options, /href="#main-content"/, "settings must provide a skip link");
assert.match(options, /role="status"[^>]+aria-live="polite"/, "settings feedback must be announced");
const messages = JSON.parse(await readFile("src/_locales/en/messages.json", "utf8"));
for (const key of ["extensionName", "extensionDescription", "actionTitle", "popupTitle", "settingsTitle", "welcomeTitle"]) {
  assert.equal(typeof messages[key]?.message, "string", `missing localization message ${key}`);
}
const inPageUi = await readFile("src/content/ui.ts", "utf8");
assert.match(inPageUi, /aria-label=\"Stream recovery countdown\"|setAttribute\("aria-label", "Stream recovery countdown"\)/, "countdown must have an accessible name");
assert.match(inPageUi, /button:focus-visible/, "in-page actions must expose keyboard focus");
assert.match(inPageUi, /prefers-reduced-motion/, "in-page feedback must honor reduced motion");
console.log("Accessibility and localization static gate passed for popup, settings, and onboarding pages.");
