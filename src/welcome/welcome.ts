import { DISCLAIMER } from "../shared/defaults";
import { apiCall, ext, originPattern, sendMessage } from "../shared/api";
import { localizeDocument } from "../shared/i18n";
import { getDisclaimerAcknowledged } from "../shared/settings";
import type { RuntimeMessage } from "../shared/types";

localizeDocument();

const agree = byId<HTMLInputElement>("agree");
const continueButton = byId<HTMLButtonElement>("continue");
const feedback = byId("feedback");
const firstSite = byId<HTMLInputElement>("first-site");

byId("disclaimer").textContent = DISCLAIMER;
agree.addEventListener("change", () => { continueButton.disabled = !agree.checked; });
continueButton.addEventListener("click", () => void acknowledge());
byId("save-mode").addEventListener("click", () => void saveMode());
byId("skip-site").addEventListener("click", () => showStep(4));
byId("enable-site").addEventListener("click", () => void enableFirstSite());
byId("finish").addEventListener("click", () => void openSettings());
document.querySelectorAll<HTMLButtonElement>("[data-back]").forEach((button) => {
  button.addEventListener("click", () => showStep(Number(button.dataset.back)));
});
void resumeAcknowledgedSetup();

async function resumeAcknowledgedSetup(): Promise<void> {
  try {
    if (await getDisclaimerAcknowledged()) {
      agree.checked = true;
      continueButton.disabled = false;
      showStep(2);
    }
  } catch { /* The first step remains usable if storage is temporarily unavailable. */ }
}

async function acknowledge(): Promise<void> {
  if (!agree.checked) return;
  await runBusy(continueButton, async () => {
    await sendMessage({ type: "ACKNOWLEDGE_DISCLAIMER" } satisfies RuntimeMessage);
    showStep(2);
  });
}

async function saveMode(): Promise<void> {
  const selected = document.querySelector<HTMLInputElement>('input[name="recovery-mode"]:checked')?.value ?? "balanced";
  const patch = selected === "observe"
    ? { autoRecover: false, autoRefresh: false }
    : selected === "gentle"
      ? { autoRecover: true, autoRefresh: false }
      : { autoRecover: true, autoRefresh: true };
  await runBusy(byId<HTMLButtonElement>("save-mode"), async () => {
    const result = await sendMessage<{ ok?: boolean; error?: string }>({ type: "UPDATE_GLOBAL_SETTINGS", patch } satisfies RuntimeMessage);
    if (result?.ok === false) throw new Error(result.error || "Could not save the recovery posture.");
    showStep(3);
  });
}

async function enableFirstSite(): Promise<void> {
  const origin = normalizeOrigin(firstSite.value);
  if (!origin) {
    setFeedback("Enter an http:// or https:// website origin, such as https://example.com.");
    firstSite.focus();
    return;
  }
  const pattern = originPattern(origin);
  if (!pattern) return;
  await runBusy(byId<HTMLButtonElement>("enable-site"), async () => {
    const granted = await apiCall<boolean>(ext.permissions.request, ext.permissions, { origins: [pattern] });
    if (!granted) throw new Error("Site access was not granted. You can enable it later from the toolbar.");
    try {
      const draft = await sendMessage<{ ok?: boolean; error?: string }>({
        type: "SET_SITE_OVERRIDES", origin, overrides: { enabled: false }, replace: false
      } satisfies RuntimeMessage);
      if (draft?.ok === false) throw new Error(draft.error || "Could not save the site configuration.");
      const enabled = await sendMessage<{ ok: boolean; error?: string }>({ type: "SET_SITE_ENABLED", origin, enabled: true } satisfies RuntimeMessage);
      if (!enabled.ok) throw new Error(enabled.error || "Could not enable monitoring on this site.");
    } catch (error) {
      await apiCall<boolean>(ext.permissions.remove, ext.permissions, { origins: [pattern] }).catch(() => false);
      throw error;
    }
    byId("setup-summary").textContent = `${new URL(origin).host} is enabled. Open a stream there and use the toolbar popup to watch its live health.`;
    showStep(4);
  });
}

async function openSettings(): Promise<void> {
  try {
    await apiCall<void>(ext.runtime.openOptionsPage, ext.runtime);
    window.close();
  } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
}

function showStep(step: number): void {
  const currentStep = Math.min(4, Math.max(1, step));
  document.querySelectorAll<HTMLElement>("[data-step]").forEach((section) => {
    section.hidden = Number(section.dataset.step) !== currentStep;
  });
  document.querySelectorAll<HTMLElement>("[data-progress]").forEach((item) => {
    const itemStep = Number(item.dataset.progress);
    item.toggleAttribute("aria-current", itemStep === currentStep);
    item.classList.toggle("complete", itemStep < currentStep);
  });
  feedback.textContent = "";
  document.querySelector<HTMLElement>(`[data-step="${currentStep}"] h2`)?.focus({ preventScroll: true });
}

async function runBusy(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;
  feedback.textContent = "";
  try { await action(); }
  catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
  finally { button.disabled = false; }
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return (url.protocol === "http:" || url.protocol === "https:") ? url.origin : null;
  } catch { return null; }
}

function setFeedback(value: string): void { feedback.textContent = value; }
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
