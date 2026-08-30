import { apiCall, ext, getOrigin, originPattern, queryActiveTab, sendMessage } from "../shared/api";
import { localizeDocument } from "../shared/i18n";
import type { PopupState, RuntimeMessage, SiteSettings } from "../shared/types";

localizeDocument();

const el = {
  acknowledgement: byId<HTMLElement>("acknowledgement"), acknowledge: byId<HTMLButtonElement>("acknowledge"), controls: byId<HTMLElement>("controls"),
  siteLabel: byId("site-label"), statusDot: byId("status-dot"), statusTitle: byId("status-title"), statusDetail: byId("status-detail"),
  confidenceWrap: byId("confidence-wrap"), confidenceBar: byId<HTMLElement>("confidence-bar"), confidenceLabel: byId("confidence-label"), evidence: byId<HTMLUListElement>("evidence"),
  diagnosis: byId("diagnosis"), streamKind: byId("stream-kind"), liveLag: byId("live-lag"), bufferAhead: byId("buffer-ahead"),
  globalEnabled: byId<HTMLInputElement>("global-enabled"), siteEnabled: byId<HTMLInputElement>("site-enabled"),
  autoRefresh: byId<HTMLInputElement>("auto-refresh"), autoMaximize: byId<HTMLInputElement>("auto-maximize"),
  refreshNow: byId<HTMLButtonElement>("refresh-now"), maximizeNow: byId<HTMLButtonElement>("maximize-now"), pipNow: byId<HTMLButtonElement>("pip-now"), pinPlayer: byId<HTMLButtonElement>("pin-player"),
  jumpLive: byId<HTMLButtonElement>("jump-live"), eventDuration: byId<HTMLSelectElement>("event-duration"), eventMode: byId<HTMLButtonElement>("event-mode"), eventStop: byId<HTMLButtonElement>("event-stop"),
  snoozeDuration: byId<HTMLSelectElement>("snooze-duration"), snooze: byId<HTMLButtonElement>("snooze"), resume: byId<HTMLButtonElement>("resume"),
  countdownActions: byId("countdown-actions"), extendCountdown: byId<HTMLButtonElement>("extend-countdown"), cancelCountdown: byId<HTMLButtonElement>("cancel-countdown"),
  resetAttempts: byId<HTMLButtonElement>("reset-attempts"), attemptCount: byId("attempt-count"), activityList: byId<HTMLOListElement>("activity-list"),
  feedback: byId("feedback"), openSettings: byId<HTMLButtonElement>("open-settings"), openDisclaimer: byId<HTMLButtonElement>("open-disclaimer"), openDiagnostics: byId<HTMLButtonElement>("open-diagnostics"),
  markCorrect: byId<HTMLButtonElement>("mark-correct"), markFalseAlarm: byId<HTMLButtonElement>("mark-false-alarm")
};

let tabId: number | undefined;
let origin: string | null = null;
let state: PopupState | null = null;
let mutating = false;
void initialize();

async function initialize(): Promise<void> {
  bindEvents();
  try {
    const tab = await queryActiveTab();
    tabId = tab?.id;
    origin = getOrigin(tab?.url);
    el.siteLabel.textContent = origin ? new URL(origin === "file://" ? "file:///" : origin).host || "Local file" : "Restricted browser page";
    await refreshState();
  } catch (error) {
    el.siteLabel.textContent = "Firefox tab unavailable";
    el.feedback.textContent = `Extension startup error: ${error instanceof Error ? error.message : String(error)}`;
  }
  window.setInterval(() => { if (!mutating) void refreshState(false); }, 1000);
}

function bindEvents(): void {
  el.acknowledge.addEventListener("click", () => runMutation(async () => { await sendMessage({ type: "ACKNOWLEDGE_DISCLAIMER" } satisfies RuntimeMessage); }));
  el.globalEnabled.addEventListener("change", () => runMutation(async () => { await sendMessage({ type: "UPDATE_GLOBAL_SETTINGS", patch: { enabled: el.globalEnabled.checked } } satisfies RuntimeMessage); }));
  el.siteEnabled.addEventListener("change", () => runMutation(async () => {
    if (!origin) throw new Error("This browser page cannot be monitored.");
    if (el.siteEnabled.checked) {
      const pattern = originPattern(origin);
      if (!pattern || !await apiCall<boolean>(ext.permissions.request, ext.permissions, { origins: [pattern] })) throw new Error("Site access was not granted.");
    }
    const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "SET_SITE_ENABLED", origin, enabled: el.siteEnabled.checked, tabId } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || "Could not update site access.");
  }));
  el.autoRefresh.addEventListener("change", () => setSiteOverrides({ autoRefresh: el.autoRefresh.checked }));
  el.autoMaximize.addEventListener("change", () => setSiteOverrides({ autoMaximize: el.autoMaximize.checked }));
  el.refreshNow.addEventListener("click", () => runAndClose({ type: "MANUAL_REFRESH", tabId: requireTab(), origin: requireOrigin() }));
  el.maximizeNow.addEventListener("click", () => runAndClose({ type: "MANUAL_MAXIMIZE", tabId: requireTab() }));
  el.pipNow.addEventListener("click", () => runAndClose({ type: "MANUAL_PICTURE_IN_PICTURE", tabId: requireTab() }));
  el.pinPlayer.addEventListener("click", () => runAndClose({ type: "PIN_PRIMARY_VIDEO", tabId: requireTab() }));
  el.jumpLive.addEventListener("click", () => runAndClose({ type: "MANUAL_JUMP_TO_LIVE", tabId: requireTab() }));
  el.eventMode.addEventListener("click", () => runMutation(async () => {
    await sendMessage({ type: "SET_EVENT_MODE", tabId: requireTab(), until: Date.now() + Number(el.eventDuration.value) * 60_000 } satisfies RuntimeMessage);
  }));
  el.eventStop.addEventListener("click", () => runMutation(async () => { await sendMessage({ type: "SET_EVENT_MODE", tabId: requireTab(), until: null } satisfies RuntimeMessage); }));
  el.snooze.addEventListener("click", () => runMutation(async () => {
    const minutes = Number(el.snoozeDuration.value);
    const until = minutes === -1 ? -1 : Date.now() + minutes * 60_000;
    await sendMessage({ type: "SNOOZE_TAB", tabId: requireTab(), until } satisfies RuntimeMessage);
  }));
  el.resume.addEventListener("click", () => runMutation(async () => { await sendMessage({ type: "SNOOZE_TAB", tabId: requireTab(), until: null } satisfies RuntimeMessage); }));
  el.extendCountdown.addEventListener("click", () => runMutation(async () => { await sendMessage({ type: "EXTEND_COUNTDOWN", tabId: requireTab(), seconds: 30 } satisfies RuntimeMessage); }));
  el.cancelCountdown.addEventListener("click", () => runMutation(async () => { await sendMessage({ type: "CANCEL_TAB_COUNTDOWN", tabId: requireTab() } satisfies RuntimeMessage); }));
  el.resetAttempts.addEventListener("click", () => runMutation(async () => { await sendMessage({ type: "RESET_TAB_ATTEMPTS", tabId: requireTab() } satisfies RuntimeMessage); }));
  el.openSettings.addEventListener("click", () => void openOptions(""));
  el.openDisclaimer.addEventListener("click", () => void openOptions("#disclaimer"));
  el.openDiagnostics.addEventListener("click", () => void openOptions("#diagnostics"));
  el.markCorrect.addEventListener("click", () => markOutcome(true));
  el.markFalseAlarm.addEventListener("click", () => markOutcome(false));
}

function markOutcome(correct: boolean): void {
  void runMutation(async () => {
    await sendMessage({ type: "RECORD_USER_FEEDBACK", origin: requireOrigin(), correct, failureKind: state?.status.diagnosis.kind ?? "UNKNOWN_FAILURE" } satisfies RuntimeMessage);
    await sendMessage({ type: "LOG_HISTORY", entry: { event: correct ? "user-marked-correct" : "user-marked-false-alarm", detail: correct ? "User marked the latest recovery as correct" : "User marked the latest detection as a false alarm", level: correct ? "success" : "warning", url: state?.status.pageUrl ?? origin ?? "", metadata: { state: state?.status.state, confidence: state?.status.confidence, failureKind: state?.status.diagnosis.kind } } } satisfies RuntimeMessage);
  });
}

function setSiteOverrides(overrides: SiteSettings): void {
  void runMutation(async () => { await sendMessage({ type: "SET_SITE_OVERRIDES", origin: requireOrigin(), overrides } satisfies RuntimeMessage); });
}

function runAndClose(message: RuntimeMessage): void {
  void runMutation(async () => { await sendMessage(message); window.close(); });
}

async function runMutation(action: () => Promise<void>): Promise<void> {
  if (mutating) return;
  mutating = true;
  el.feedback.textContent = "";
  try { await action(); }
  catch (error) { el.feedback.textContent = error instanceof Error ? error.message : String(error); }
  finally { await refreshState(); mutating = false; }
}

async function refreshState(showError = true): Promise<void> {
  try {
    state = await sendMessage<PopupState>({ type: "GET_POPUP_STATE", tabId, origin: origin ?? undefined } satisfies RuntimeMessage);
    render();
  } catch (error) { if (showError) el.feedback.textContent = `Extension background unavailable: ${String(error)}`; }
}

function render(): void {
  if (!state) return;
  el.acknowledgement.hidden = state.acknowledged;
  el.controls.hidden = !state.acknowledged;
  el.controls.toggleAttribute("inert", !state.acknowledged);
  el.globalEnabled.checked = state.settings.enabled;
  el.siteEnabled.checked = state.effective?.siteEnabled ?? false;
  el.autoRefresh.checked = state.effective?.autoRefresh ?? state.settings.autoRefresh;
  el.autoMaximize.checked = state.effective?.autoMaximize ?? state.settings.autoMaximize;
  const usable = state.acknowledged && state.supportedPage && state.settings.enabled;
  el.siteEnabled.disabled = !usable;
  for (const input of [el.autoRefresh, el.autoMaximize]) input.disabled = !usable || !state.effective?.siteEnabled;
  for (const button of [el.refreshNow, el.maximizeNow, el.pipNow, el.pinPlayer, el.snooze, el.jumpLive, el.eventMode]) button.disabled = !usable || !state.effective?.siteEnabled;

  const labels: Record<string, string> = {
    DISABLED: "Disabled", SITE_NOT_ENABLED: "Site not enabled", URL_EXCLUDED: "URL excluded", SNOOZED: "Monitoring snoozed", OFFLINE: "Offline",
    NO_VIDEO_FOUND: "No video detected", LIMITED_VISIBILITY: "Limited player visibility", MONITORING: "Monitoring", HEALTHY: "Stream healthy", SUSPECTED_DOWN: "Stream may be down",
    RECOVERING: "Recovery in progress", COUNTDOWN: "Refresh scheduled", REFRESHING: "Refreshing", PAUSED_TOO_MANY_REFRESHES: "Recovery paused",
    MAXIMIZE_BLOCKED: "Maximize needs a click", ERROR: "Extension error"
  };
  const statusClass = state.status.state === "HEALTHY" ? "healthy"
    : ["SUSPECTED_DOWN", "COUNTDOWN", "MAXIMIZE_BLOCKED", "RECOVERING", "OFFLINE"].includes(state.status.state) ? "warning"
      : ["ERROR", "PAUSED_TOO_MANY_REFRESHES"].includes(state.status.state) ? "error"
        : state.status.state === "MONITORING" ? "monitoring" : "";
  el.statusDot.className = `status-dot ${statusClass}`;
  el.statusTitle.textContent = labels[state.status.state] ?? state.status.state;
  el.statusDetail.textContent = state.status.detail;
  el.confidenceWrap.hidden = state.status.confidence === 0;
  el.confidenceBar.style.width = `${state.status.confidence}%`;
  el.confidenceLabel.textContent = `${state.status.confidence}% failure confidence`;
  el.evidence.replaceChildren(...state.status.evidence.slice(0, 3).map((item) => {
    const li = document.createElement("li"); li.textContent = item.detail; return li;
  }));
  el.diagnosis.textContent = state.status.diagnosis.kind.replaceAll("_", " ").toLowerCase();
  el.streamKind.textContent = state.status.streamKind.replaceAll("_", " ").toLowerCase();
  el.liveLag.textContent = state.status.liveEdgeLagSeconds === null ? "—" : `${Math.round(state.status.liveEdgeLagSeconds)}s`;
  el.bufferAhead.textContent = state.status.bufferAheadSeconds === null ? "—" : `${state.status.bufferAheadSeconds.toFixed(1)}s`;
  el.jumpLive.disabled = el.jumpLive.disabled || state.status.liveEdgeLagSeconds === null || state.status.streamKind === "VOD";

  const snoozed = state.snoozedUntil === -1 || (state.snoozedUntil !== null && state.snoozedUntil > Date.now());
  el.resume.hidden = !snoozed;
  el.snooze.hidden = snoozed;
  el.snoozeDuration.hidden = snoozed;
  el.countdownActions.hidden = state.status.state !== "COUNTDOWN";
  el.resetAttempts.hidden = state.status.state !== "PAUSED_TOO_MANY_REFRESHES";
  el.attemptCount.textContent = state.refreshAttempts ? `${state.refreshAttempts} automatic page reload attempt${state.refreshAttempts === 1 ? "" : "s"} in the current window` : "No recent automatic page reloads";
  const eventActive = state.eventModeUntil !== null && state.eventModeUntil > Date.now();
  el.eventMode.hidden = eventActive; el.eventDuration.hidden = eventActive; el.eventStop.hidden = !eventActive;
  el.activityList.replaceChildren(...state.recentHistory.slice(0, 4).map((item) => {
    const li = document.createElement("li");
    const time = document.createElement("time"); time.textContent = new Date(item.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const copy = document.createElement("span"); copy.textContent = item.detail;
    li.append(time, copy); return li;
  }));
}

async function openOptions(hash: string): Promise<void> {
  el.feedback.textContent = "";
  try {
    if (!hash) await apiCall<void>(ext.runtime.openOptionsPage, ext.runtime);
    else await apiCall<chrome.tabs.Tab>(ext.tabs.create, ext.tabs, { url: `${ext.runtime.getURL("options.html")}${hash}` });
    window.close();
  } catch (error) {
    el.feedback.textContent = `Could not open settings: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function requireTab(): number { if (tabId === undefined) throw new Error("This tab is unavailable."); return tabId; }
function requireOrigin(): string { if (!origin) throw new Error("This page has no configurable origin."); return origin; }
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id); if (!element) throw new Error(`Missing element #${id}`); return element as T;
}
