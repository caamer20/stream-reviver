import { apiCall, ext, getOrigin, originPattern, queryActiveTab, sendMessage } from "../shared/api";
import { DISCLAIMER } from "../shared/defaults";
import { localizeDocument, message } from "../shared/i18n";
import {
  getPopupPresentation,
  getSiteOverrideMode,
  withSiteOverride,
  type PopupCopy,
  type PopupPresentation,
  type SiteOverrideMode
} from "../shared/popup-presentation";
import type { FailureKind, HistoryEvent, PopupState, RuntimeMessage } from "../shared/types";

localizeDocument();
try { document.documentElement.lang = ext.i18n?.getUILanguage?.() || "en"; } catch { /* English fallback remains declared */ }

const el = {
  acknowledgement: byId<HTMLElement>("acknowledgement"),
  acknowledgeCheck: byId<HTMLInputElement>("acknowledge-check"),
  acknowledge: byId<HTMLButtonElement>("acknowledge"),
  disclaimerCopy: byId("disclaimer-copy"),
  controls: byId<HTMLElement>("controls"),
  siteLabel: byId("site-label"),
  statusCard: byId("status-card"),
  protectionChip: byId("protection-chip"),
  freshness: byId("freshness"),
  statusDot: byId("status-dot"),
  statusTitle: byId("status-title"),
  statusDetail: byId("status-detail"),
  coverage: byId("coverage"),
  evidenceStrength: byId("evidence-strength"),
  nextActionText: byId("next-action-text"),
  statusAnnouncer: byId("status-announcer"),
  evidence: byId<HTMLUListElement>("evidence"),
  compatibilityLimitations: byId<HTMLUListElement>("compatibility-limitations"),
  diagnosis: byId("diagnosis"),
  streamKind: byId("stream-kind"),
  liveLag: byId("live-lag"),
  bufferAhead: byId("buffer-ahead"),
  globalEnabled: byId<HTMLInputElement>("global-enabled"),
  siteEnabled: byId<HTMLInputElement>("site-enabled"),
  autoRecover: byId<HTMLSelectElement>("auto-recover"),
  autoRecoverEffective: byId("auto-recover-effective"),
  autoRefresh: byId<HTMLSelectElement>("auto-refresh"),
  autoRefreshEffective: byId("auto-refresh-effective"),
  autoMaximize: byId<HTMLSelectElement>("auto-maximize"),
  autoMaximizeEffective: byId("auto-maximize-effective"),
  contextActions: byId("context-actions"),
  refreshNow: byId<HTMLButtonElement>("refresh-now"),
  maximizeNow: byId<HTMLButtonElement>("maximize-now"),
  pipNow: byId<HTMLButtonElement>("pip-now"),
  pinPlayer: byId<HTMLButtonElement>("pin-player"),
  jumpLive: byId<HTMLButtonElement>("jump-live"),
  playerActionsSection: byId<HTMLDetailsElement>("player-actions-section"),
  recoverySection: byId<HTMLDetailsElement>("recovery-section"),
  eventControls: byId("event-controls"),
  eventDuration: byId<HTMLSelectElement>("event-duration"),
  eventMode: byId<HTMLButtonElement>("event-mode"),
  eventStop: byId<HTMLButtonElement>("event-stop"),
  snoozeControls: byId("snooze-controls"),
  snoozeDuration: byId<HTMLSelectElement>("snooze-duration"),
  snooze: byId<HTMLButtonElement>("snooze"),
  resume: byId<HTMLButtonElement>("resume"),
  extendCountdown: byId<HTMLButtonElement>("extend-countdown"),
  cancelCountdown: byId<HTMLButtonElement>("cancel-countdown"),
  resetAttempts: byId<HTMLButtonElement>("reset-attempts"),
  attemptCount: byId("attempt-count"),
  activityList: byId<HTMLOListElement>("activity-list"),
  qualityFeedback: byId("quality-feedback"),
  feedback: byId("feedback"),
  openDashboard: byId<HTMLButtonElement>("open-dashboard"),
  openSettings: byId<HTMLButtonElement>("open-settings"),
  openDisclaimer: byId<HTMLButtonElement>("open-disclaimer"),
  openDiagnostics: byId<HTMLButtonElement>("open-diagnostics"),
  markCorrect: byId<HTMLButtonElement>("mark-correct"),
  markFalseAlarm: byId<HTMLButtonElement>("mark-false-alarm")
};

let tabId: number | undefined;
let origin: string | null = null;
let state: PopupState | null = null;
let mutating = false;
let lastAnnouncementKey = "";

void initialize();

async function initialize(): Promise<void> {
  el.disclaimerCopy.textContent = DISCLAIMER;
  localizeControlLabels();
  bindEvents();
  try {
    const tab = await queryActiveTab();
    tabId = tab?.id;
    origin = getOrigin(tab?.url);
    el.siteLabel.textContent = origin
      ? new URL(origin === "file://" ? "file:///" : origin).host || message("popupLocalFile", "Local file")
      : message("popupRestrictedPage", "Restricted browser page");
    await refreshState();
  } catch (error) {
    el.siteLabel.textContent = message("popupCurrentTabUnavailable", "Current tab unavailable");
    el.feedback.textContent = `${message("popupStartupError", "Extension startup error")}: ${error instanceof Error ? error.message : String(error)}`;
  }
  window.setInterval(() => { if (!mutating) void refreshState(false); }, 2_000);
  window.setInterval(renderTimeSensitiveState, 1_000);
}

function localizeControlLabels(): void {
  document.querySelector<HTMLElement>(".switches")?.setAttribute("aria-label", message("popupProtectionControls", "Protection controls"));
  el.contextActions.setAttribute("aria-label", message("popupRecommendedActions", "Recommended actions"));
  el.snoozeDuration.setAttribute("aria-label", message("popupSnoozeDuration", "Snooze duration"));
  el.eventDuration.setAttribute("aria-label", message("popupEventDuration", "High-reliability mode duration"));
}

function bindEvents(): void {
  el.acknowledgeCheck.addEventListener("change", () => { el.acknowledge.disabled = !el.acknowledgeCheck.checked; });
  el.acknowledge.addEventListener("click", () => runMutation(async () => {
    if (!el.acknowledgeCheck.checked) throw new Error(message("popupReadDisclaimerFirst", "Read and confirm the disclaimer first."));
    await sendMessage({ type: "ACKNOWLEDGE_DISCLAIMER" } satisfies RuntimeMessage);
  }));
  el.globalEnabled.addEventListener("change", () => runMutation(async () => {
    await sendMessage({ type: "UPDATE_GLOBAL_SETTINGS", patch: { enabled: el.globalEnabled.checked } } satisfies RuntimeMessage);
  }));
  el.siteEnabled.addEventListener("change", () => runMutation(async () => {
    if (!origin) throw new Error(message("popupCannotMonitorPage", "This browser page cannot be monitored."));
    if (el.siteEnabled.checked) {
      const pattern = originPattern(origin);
      if (!pattern || !await apiCall<boolean>(ext.permissions.request, ext.permissions, { origins: [pattern] })) {
        throw new Error(message("popupAccessNotGranted", "Site access was not granted. You can try again at any time."));
      }
    }
    const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "SET_SITE_ENABLED", origin, enabled: el.siteEnabled.checked, tabId } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || message("popupAccessUpdateFailed", "Could not update site access."));
  }));
  el.autoRecover.addEventListener("change", () => void setSiteOverride("autoRecover", el.autoRecover.value as SiteOverrideMode));
  el.autoRefresh.addEventListener("change", () => void setSiteOverride("autoRefresh", el.autoRefresh.value as SiteOverrideMode));
  el.autoMaximize.addEventListener("change", () => void setSiteOverride("autoMaximize", el.autoMaximize.value as SiteOverrideMode));
  el.refreshNow.addEventListener("click", () => runAndClose({ type: "MANUAL_REFRESH", tabId: requireTab(), origin: requireOrigin() }));
  el.maximizeNow.addEventListener("click", () => runAndClose({ type: "MANUAL_MAXIMIZE", tabId: requireTab() }));
  el.pipNow.addEventListener("click", () => runAndClose({ type: "MANUAL_PICTURE_IN_PICTURE", tabId: requireTab() }));
  el.pinPlayer.addEventListener("click", () => runAndClose({ type: "PIN_PRIMARY_VIDEO", tabId: requireTab() }));
  el.jumpLive.addEventListener("click", () => runAndClose({ type: "MANUAL_JUMP_TO_LIVE", tabId: requireTab() }));
  el.eventMode.addEventListener("click", () => runMutation(async () => {
    await sendMessage({ type: "SET_EVENT_MODE", tabId: requireTab(), until: Date.now() + Number(el.eventDuration.value) * 60_000 } satisfies RuntimeMessage);
  }));
  el.eventStop.addEventListener("click", () => runMutation(async () => {
    await sendMessage({ type: "SET_EVENT_MODE", tabId: requireTab(), until: null } satisfies RuntimeMessage);
  }));
  el.snooze.addEventListener("click", () => runMutation(async () => {
    const minutes = Number(el.snoozeDuration.value);
    const until = minutes === -1 ? -1 : Date.now() + minutes * 60_000;
    const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "SNOOZE_TAB", tabId: requireTab(), until } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || "Monitoring could not be snoozed.");
  }));
  el.resume.addEventListener("click", () => runMutation(async () => {
    const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "SNOOZE_TAB", tabId: requireTab(), until: null } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || "Monitoring could not be resumed.");
  }));
  el.extendCountdown.addEventListener("click", () => runMutation(async () => {
    const response = await sendMessage<{ ok: boolean; error?: string }>({
      type: "EXTEND_COUNTDOWN", tabId: requireTab(), seconds: 30
    } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || "The countdown could not be extended.");
  }));
  el.cancelCountdown.addEventListener("click", () => runMutation(async () => {
    const response = await sendMessage<{ ok: boolean; canceled?: boolean; error?: string }>({
      type: "CANCEL_TAB_COUNTDOWN", tabId: requireTab()
    } satisfies RuntimeMessage);
    if (!response.ok || !response.canceled) {
      throw new Error(response.error || "The reload was no longer pending and could not be canceled.");
    }
  }));
  el.resetAttempts.addEventListener("click", () => runMutation(async () => {
    const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "RESET_TAB_ATTEMPTS", tabId: requireTab() } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || "Recovery attempts could not be reset.");
  }));
  el.openDashboard.addEventListener("click", () => void openDashboard());
  el.openSettings.addEventListener("click", () => void openOptions(""));
  el.openDisclaimer.addEventListener("click", () => void openOptions("#disclaimer"));
  el.openDiagnostics.addEventListener("click", () => void openOptions("#diagnostics"));
  el.markCorrect.addEventListener("click", () => markOutcome(true));
  el.markFalseAlarm.addEventListener("click", () => markOutcome(false));
}

function markOutcome(correct: boolean): void {
  void runMutation(async () => {
    const context = feedbackContext(state);
    await sendMessage({ type: "RECORD_USER_FEEDBACK", origin: requireOrigin(), correct, failureKind: context.failureKind } satisfies RuntimeMessage);
    await sendMessage({
      type: "LOG_HISTORY",
      entry: {
        event: correct ? "user-marked-correct" : "user-marked-false-alarm",
        detail: correct ? "User marked the latest recovery as correct" : "User marked the latest detection as a false alarm",
        level: correct ? "success" : "warning",
        url: state?.status.pageUrl ?? origin ?? "",
        metadata: {
          state: state?.status.state,
          confidence: state?.status.confidence,
          failureKind: context.failureKind,
          recoveryCycleId: context.recoveryCycleId,
          recoveryAction: context.action
        }
      }
    } satisfies RuntimeMessage);
  });
}

function feedbackContext(current: PopupState | null): { failureKind: FailureKind; recoveryCycleId: string | null; action: string | null } {
  for (const item of current?.recentHistory ?? []) {
    const rawKind = item.metadata?.failureKind;
    if (typeof rawKind !== "string" || rawKind === "NONE" || !failureKinds.has(rawKind as FailureKind)) continue;
    return {
      failureKind: rawKind as FailureKind,
      recoveryCycleId: typeof item.metadata?.recoveryCycleId === "string" ? item.metadata.recoveryCycleId : null,
      action: typeof item.metadata?.action === "string" ? item.metadata.action : null
    };
  }
  const currentKind = current?.status.diagnosis.kind;
  return {
    failureKind: currentKind && currentKind !== "NONE" ? currentKind : "UNKNOWN_FAILURE",
    recoveryCycleId: current?.status.recoveryCycleId ?? null,
    action: current?.status.recoveryAction ?? null
  };
}

const failureKinds = new Set<FailureKind>([
  "NONE", "STARTUP_DELAY", "USER_PAUSED", "AUTOPLAY_BLOCKED", "NETWORK_OFFLINE", "NETWORK_STARVATION",
  "BUFFER_UNDERRUN", "LIVE_EDGE_DRIFT", "DECODE_FREEZE", "RENDER_FREEZE", "MEDIA_SOURCE_ERROR",
  "NO_USABLE_SOURCE", "LIVE_STREAM_ENDED", "PLAYER_REPLACED", "PLAYER_CONTROL_ERROR", "WEBRTC_NETWORK_FAILURE",
  "ACCESS_INTERRUPTION", "TAB_SUSPENDED", "BROWSER_RESUMED", "UNKNOWN_FAILURE"
]);

async function setSiteOverride(key: "autoRecover" | "autoRefresh" | "autoMaximize", mode: SiteOverrideMode): Promise<void> {
  await runMutation(async () => {
    if (!state) throw new Error(message("popupStateUnavailable", "Current settings are unavailable."));
    const site = withSiteOverride(state.settings.perSite[requireOrigin()], key, mode);
    await sendMessage({ type: "SET_SITE_OVERRIDES", origin: requireOrigin(), overrides: site, replace: true } satisfies RuntimeMessage);
  });
}

function runAndClose(runtimeMessage: RuntimeMessage): void {
  void runMutation(async () => { await sendMessage(runtimeMessage); window.close(); });
}

async function runMutation(action: () => Promise<void>): Promise<void> {
  if (mutating) return;
  mutating = true;
  el.controls.setAttribute("aria-busy", "true");
  el.feedback.textContent = "";
  try { await action(); }
  catch (error) { el.feedback.textContent = error instanceof Error ? error.message : String(error); }
  finally {
    await refreshState();
    el.controls.removeAttribute("aria-busy");
    mutating = false;
  }
}

async function refreshState(showError = true): Promise<void> {
  try {
    state = await sendMessage<PopupState>({ type: "GET_POPUP_STATE", tabId, origin: origin ?? undefined } satisfies RuntimeMessage);
    render();
  } catch (error) {
    if (showError) el.feedback.textContent = `${message("popupBackgroundUnavailable", "Extension background unavailable")}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function render(): void {
  if (!state) return;
  el.acknowledgement.hidden = state.acknowledged;
  el.controls.hidden = !state.acknowledged;
  el.controls.toggleAttribute("inert", !state.acknowledged);
  if (!state.acknowledged) return;

  el.globalEnabled.checked = state.settings.enabled;
  el.siteEnabled.checked = state.effective?.siteEnabled ?? false;
  const siteSettings = origin ? state.settings.perSite[origin] : undefined;
  const recoverMode = getSiteOverrideMode(siteSettings, "autoRecover");
  const refreshMode = getSiteOverrideMode(siteSettings, "autoRefresh");
  const maximizeMode = getSiteOverrideMode(siteSettings, "autoMaximize");
  el.autoRecover.value = recoverMode;
  el.autoRefresh.value = refreshMode;
  el.autoMaximize.value = maximizeMode;
  renderEffectiveSetting(el.autoRecoverEffective, recoverMode, state.settings.autoRecover);
  renderEffectiveSetting(el.autoRefreshEffective, refreshMode, state.settings.autoRefresh);
  renderEffectiveSetting(el.autoMaximizeEffective, maximizeMode, state.settings.autoMaximize);

  const canConfigureSite = state.supportedPage && state.settings.enabled;
  el.siteEnabled.disabled = !canConfigureSite;
  el.autoRecover.disabled = !canConfigureSite || !state.effective?.siteEnabled;
  el.autoRefresh.disabled = !canConfigureSite || !state.effective?.siteEnabled;
  el.autoMaximize.disabled = !canConfigureSite || !state.effective?.siteEnabled;

  const presentation = getPopupPresentation(state);
  renderPresentation(presentation);
  renderTechnicalDetails();
  renderActions(presentation);
  renderActivity();
}

function renderTimeSensitiveState(): void {
  if (!state || !state.acknowledged || mutating) return;
  const presentation = getPopupPresentation(state);
  renderPresentation(presentation);
  renderActions(presentation);
}

function renderPresentation(presentation: PopupPresentation): void {
  const protection = resolveCopy(presentation.protection);
  const headline = resolveCopy(presentation.headline);
  const detail = resolveCopy(presentation.detail);
  const nextAction = resolveCopy(presentation.nextAction);
  setText(el.protectionChip, protection);
  setText(el.freshness, resolveCopy(presentation.freshness));
  setText(el.statusTitle, headline);
  setText(el.statusDetail, detail);
  setText(el.coverage, resolveCopy(presentation.coverage));
  setText(el.evidenceStrength, presentation.evidenceStrength);
  setText(el.nextActionText, nextAction);
  el.statusDot.className = `status-dot ${presentation.tone}`;
  el.protectionChip.className = `protection-chip ${presentation.activeProtection ? presentation.tone : ""}`;
  el.statusCard.toggleAttribute("data-stale", presentation.stale);
  if (presentation.announcementKey !== lastAnnouncementKey) {
    lastAnnouncementKey = presentation.announcementKey;
    el.statusAnnouncer.textContent = `${protection}. ${headline}. ${detail} ${message("popupNext", "Next")}: ${nextAction}`;
  }
}

function renderTechnicalDetails(): void {
  if (!state) return;
  const status = state.status;
  replaceTextList(el.evidence, status.evidence.slice(0, 3).map((item) => item.detail));
  replaceTextList(
    el.compatibilityLimitations,
    status.compatibility.limitations.length
      ? status.compatibility.limitations.slice(0, 4)
      : [message("popupNoCoverageLimitations", "No coverage limitations reported.")]
  );
  setText(el.diagnosis, humanize(status.diagnosis.kind));
  setText(el.streamKind, humanize(status.streamKind));
  setText(el.liveLag, status.liveEdgeLagSeconds === null ? "—" : `${Math.round(status.liveEdgeLagSeconds)}s`);
  setText(el.bufferAhead, status.bufferAheadSeconds === null ? "—" : `${status.bufferAheadSeconds.toFixed(1)}s`);
}

function renderActions(presentation: PopupPresentation): void {
  if (!state) return;
  const actions = presentation.actions;
  setVisible(el.refreshNow, actions.refresh);
  setVisible(el.maximizeNow, actions.maximize);
  setVisible(el.jumpLive, actions.jumpLive);
  setVisible(el.cancelCountdown, actions.cancelCountdown);
  setVisible(el.extendCountdown, actions.extendCountdown);
  setVisible(el.resetAttempts, actions.resetAttempts);
  setVisible(el.resume, actions.resume);
  el.contextActions.hidden = ![actions.refresh, actions.maximize, actions.jumpLive, actions.cancelCountdown, actions.extendCountdown, actions.resetAttempts, actions.resume].some(Boolean);

  setVisible(el.pipNow, actions.pictureInPicture);
  setVisible(el.pinPlayer, actions.pickPlayer);
  el.playerActionsSection.hidden = !actions.pictureInPicture && !actions.pickPlayer;

  el.snoozeControls.hidden = !actions.snooze;
  el.snooze.disabled = !actions.snooze;
  const eventActive = state.eventModeUntil !== null && state.eventModeUntil > Date.now();
  el.eventControls.hidden = !actions.eventMode && !eventActive;
  el.eventMode.hidden = !actions.eventMode || eventActive;
  el.eventDuration.hidden = !actions.eventMode || eventActive;
  el.eventStop.hidden = !eventActive;
  el.recoverySection.hidden = el.snoozeControls.hidden && el.eventControls.hidden && state.refreshAttempts === 0;
  setText(el.attemptCount, attemptCopy(state.refreshAttempts));
}

function renderActivity(): void {
  if (!state) return;
  const signature = JSON.stringify(state.recentHistory.slice(0, 4).map((item) => [item.id, item.timestamp, item.detail]));
  if (el.activityList.dataset.signature !== signature) {
    el.activityList.dataset.signature = signature;
    el.activityList.replaceChildren(...state.recentHistory.slice(0, 4).map(activityItem));
  }
  el.qualityFeedback.hidden = !hasUnratedRecovery(state.recentHistory);
}

function activityItem(item: HistoryEvent): HTMLLIElement {
  const li = document.createElement("li");
  const time = document.createElement("time");
  const date = new Date(item.timestamp);
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const copy = document.createElement("span");
  copy.textContent = item.detail;
  li.append(time, copy);
  return li;
}

function hasUnratedRecovery(history: HistoryEvent[]): boolean {
  const latestRecovery = history.findIndex((item) => ["recovery-step", "page-reload", "recovery-cycle-started"].includes(item.event));
  if (latestRecovery < 0) return false;
  const latestRating = history.findIndex((item) => item.event === "user-marked-correct" || item.event === "user-marked-false-alarm");
  return latestRating < 0 || latestRecovery < latestRating;
}

function renderEffectiveSetting(target: HTMLElement, mode: SiteOverrideMode, globalValue: boolean): void {
  if (mode === "default") {
    const value = globalValue ? message("popupSettingOn", "on") : message("popupSettingOff", "off");
    setText(target, message("popupDefaultCurrently", `Default is currently ${value}`, [value]));
  } else {
    const value = mode === "on" ? message("popupSettingOn", "on") : message("popupSettingOff", "off");
    setText(target, message("popupCustomizedCurrently", `Customized for this site: ${value}`, [value]));
  }
}

function resolveCopy(copy: PopupCopy): string {
  return message(copy.key, copy.fallback, copy.substitutions);
}

function attemptCopy(attempts: number): string {
  if (!attempts) return message("popupNoRecentReloads", "No recent automatic page reloads");
  return attempts === 1
    ? message("popupOneReloadAttempt", "1 automatic page reload attempt in the current window")
    : message("popupReloadAttempts", `${attempts} automatic page reload attempts in the current window`, [String(attempts)]);
}

function replaceTextList(list: HTMLUListElement, items: string[]): void {
  const signature = JSON.stringify(items);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").toLowerCase();
}

function setVisible(element: HTMLElement, visible: boolean): void { element.hidden = !visible; }
function setText(element: HTMLElement, value: string): void { if (element.textContent !== value) element.textContent = value; }

async function openOptions(hash: string): Promise<void> {
  el.feedback.textContent = "";
  try {
    if (!hash) await apiCall<void>(ext.runtime.openOptionsPage, ext.runtime);
    else await apiCall<chrome.tabs.Tab>(ext.tabs.create, ext.tabs, { url: `${ext.runtime.getURL("options.html")}${hash}` });
    window.close();
  } catch (error) {
    el.feedback.textContent = `${message("popupOpenSettingsFailed", "Could not open settings")}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function openDashboard(): Promise<void> {
  el.feedback.textContent = "";
  try {
    await apiCall<chrome.tabs.Tab>(ext.tabs.create, ext.tabs, { url: ext.runtime.getURL("dashboard.html") });
    window.close();
  } catch (error) {
    el.feedback.textContent = `${message("popupOpenDashboardFailed", "Could not open Mission Control")}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function requireTab(): number {
  if (tabId === undefined) throw new Error(message("popupTabUnavailable", "This tab is unavailable."));
  return tabId;
}

function requireOrigin(): string {
  if (!origin) throw new Error(message("popupNoOrigin", "This page has no configurable origin."));
  return origin;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
