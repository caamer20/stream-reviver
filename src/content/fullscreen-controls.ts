export interface FullscreenControlCandidate<T> {
  element: T;
  accessibleLabel: string;
  visible: boolean;
  disabled: boolean;
  sensitive: boolean;
  withinContainer: boolean;
  directlyAdjacent: boolean;
}

export type FullscreenControlDiscovery<T> =
  | { kind: "found"; button: T; matchCount: 1 }
  | { kind: "ambiguous"; button: null; matchCount: number }
  | { kind: "none"; button: null; matchCount: 0 };

const CONTROL_SELECTOR = "button,[role='button'],input[type='button']";
const SENSITIVE_CONTEXT_SELECTOR = [
  "[role='dialog'][aria-modal='true']",
  "dialog[open]",
  "form",
  "[class*='login' i]", "[id*='login' i]",
  "[class*='paywall' i]", "[id*='paywall' i]",
  "[class*='captcha' i]", "[id*='captcha' i]",
  "[class*='checkout' i]", "[id*='checkout' i]",
  "[class*='payment' i]", "[id*='payment' i]",
  "[class*='purchase' i]", "[id*='purchase' i]",
  "[data-sensitive='true']"
].join(",");

/**
 * Pure selection policy kept separate from DOM discovery so ambiguity and
 * safety invariants are exhaustively testable.
 */
export function chooseGenericFullscreenControl<T>(
  candidates: readonly FullscreenControlCandidate<T>[]
): FullscreenControlDiscovery<T> {
  const matches = candidates.filter((candidate) =>
    candidate.visible && !candidate.disabled && !candidate.sensitive &&
    (candidate.withinContainer || candidate.directlyAdjacent) &&
    isEnterFullscreenLabel(candidate.accessibleLabel)
  );
  if (matches.length === 1) return { kind: "found", button: matches[0].element, matchCount: 1 };
  if (matches.length > 1) return { kind: "ambiguous", button: null, matchCount: matches.length };
  return { kind: "none", button: null, matchCount: 0 };
}

/**
 * Discovers a generic native control only in the selected player's immediate
 * UI neighborhood. Controls elsewhere on the page are never auto-clicked.
 */
export function discoverGenericFullscreenControl(
  playerContainer: HTMLElement
): FullscreenControlDiscovery<HTMLElement> {
  const scoped = collectScopedControls(playerContainer);
  const candidates = [...scoped.entries()].map(([element, relation]) => ({
    element,
    accessibleLabel: [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-tooltip")]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
    visible: isElementVisible(element),
    disabled: element.matches(":disabled,[aria-disabled='true']"),
    sensitive: !!element.closest(SENSITIVE_CONTEXT_SELECTOR),
    withinContainer: relation === "within",
    directlyAdjacent: relation === "adjacent"
  }));
  return chooseGenericFullscreenControl(candidates);
}

function isEnterFullscreenLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return /full[ -]?screen|enter[ -]?full|maximize/.test(normalized) && !/exit|leave|close/.test(normalized);
}

function collectScopedControls(container: HTMLElement): Map<HTMLElement, "within" | "adjacent"> {
  const controls = new Map<HTMLElement, "within" | "adjacent">();
  collectControls(container, "within", controls);
  if (container.previousElementSibling) collectControls(container.previousElementSibling, "adjacent", controls);
  if (container.nextElementSibling) collectControls(container.nextElementSibling, "adjacent", controls);
  return controls;
}

function collectControls(
  scope: Element,
  relation: "within" | "adjacent",
  controls: Map<HTMLElement, "within" | "adjacent">
): void {
  if (scope instanceof HTMLElement && scope.matches(CONTROL_SELECTOR)) controls.set(scope, relation);
  for (const element of scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) controls.set(element, relation);
}

function isElementVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width >= 8 && rect.height >= 8 && style.display !== "none" && style.visibility !== "hidden";
}
