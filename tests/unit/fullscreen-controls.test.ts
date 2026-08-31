import test from "node:test";
import assert from "node:assert/strict";
import { chooseGenericFullscreenControl, type FullscreenControlCandidate } from "../../src/content/fullscreen-controls";

type Target = { id: string };

function candidate(
  id: string,
  overrides: Partial<FullscreenControlCandidate<Target>> = {}
): FullscreenControlCandidate<Target> {
  return {
    element: { id }, accessibleLabel: "Enter fullscreen", visible: true, disabled: false,
    sensitive: false, withinContainer: true, directlyAdjacent: false, ...overrides
  };
}

test("selects one clearly labelled control inside the player container", () => {
  const result = chooseGenericFullscreenControl([candidate("inside")]);
  assert.equal(result.kind, "found");
  assert.equal(result.button?.id, "inside");
});

test("selects one clearly labelled control in a directly adjacent sibling", () => {
  const result = chooseGenericFullscreenControl([
    candidate("adjacent", { withinContainer: false, directlyAdjacent: true })
  ]);
  assert.equal(result.kind, "found");
  assert.equal(result.button?.id, "adjacent");
});

test("never selects a matching control elsewhere on the page", () => {
  const result = chooseGenericFullscreenControl([
    candidate("global", { withinContainer: false, directlyAdjacent: false })
  ]);
  assert.equal(result.kind, "none");
});

test("returns ambiguity instead of clicking the first eligible control", () => {
  const result = chooseGenericFullscreenControl([candidate("one"), candidate("two")]);
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.button, null);
  assert.equal(result.matchCount, 2);
});

test("excludes hidden, disabled, sensitive, exit, and unlabelled controls", () => {
  const result = chooseGenericFullscreenControl([
    candidate("hidden", { visible: false }),
    candidate("disabled", { disabled: true }),
    candidate("sensitive", { sensitive: true }),
    candidate("exit", { accessibleLabel: "Exit fullscreen" }),
    candidate("copy-only", { accessibleLabel: "" })
  ]);
  assert.equal(result.kind, "none");
});
