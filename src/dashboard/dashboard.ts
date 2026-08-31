import { sendMessage, ext } from "../shared/api";
import { localizeDocument, message } from "../shared/i18n";
import type { RuntimeMessage } from "../shared/types";
import {
  formatRelativeTime,
  getDashboardSummary,
  getMonitorPresentation,
  isDashboardState,
  privacySafeDetail,
  privacySafeSiteLabel,
  recoveryActionLabel,
  recoveryOutcomeLabel,
  type DashboardActiveMonitor,
  type DashboardConfiguredSite,
  type DashboardRecoveryEvent,
  type DashboardState
} from "./dashboard-model";

const POLL_INTERVAL_MS = 3_000;
const MAX_RENDERED_SITES = 100;
const MAX_RENDERED_MONITORS = 50;
const MAX_RENDERED_RECOVERIES = 50;

const el = {
  main: byId<HTMLElement>("main-content"),
  loading: byId<HTMLElement>("loading-state"),
  error: byId<HTMLElement>("error-state"),
  retry: byId<HTMLButtonElement>("retry-button"),
  content: byId<HTMLElement>("dashboard-content"),
  lastUpdated: byId<HTMLTimeElement>("last-updated-time"),
  systemNotice: byId<HTMLElement>("system-notice"),
  systemNoticeTitle: byId("system-notice-title"),
  systemNoticeDetail: byId("system-notice-detail"),
  activeCount: byId("active-monitor-count"),
  healthyCount: byId("healthy-monitor-count"),
  attentionCount: byId("attention-monitor-count"),
  protectedCount: byId("protected-site-count"),
  coverageSummary: byId("coverage-summary"),
  coverageProgress: byId<HTMLProgressElement>("coverage-progress"),
  configuredSites: byId<HTMLUListElement>("configured-sites"),
  configuredSitesEmpty: byId("configured-sites-empty"),
  activeMonitors: byId("active-monitors"),
  activeMonitorsEmpty: byId("active-monitors-empty"),
  recentRecoveries: byId<HTMLOListElement>("recent-recoveries"),
  recentRecoveriesEmpty: byId("recent-recoveries-empty"),
  announcer: byId("status-announcer")
};

let refreshInFlight = false;
let hasRenderedState = false;
let lastSummarySignature = "";

localizeDocument();
try { document.documentElement.lang = ext.i18n?.getUILanguage?.() || "en"; } catch { /* The declared English fallback remains. */ }
el.retry.addEventListener("click", () => void refreshDashboard(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshDashboard(false);
});
void initialize();

async function initialize(): Promise<void> {
  await refreshDashboard(true);
  window.setInterval(() => void refreshDashboard(false), POLL_INTERVAL_MS);
}

async function refreshDashboard(showLoading: boolean): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (showLoading && !hasRenderedState) setView("loading");
  try {
    const response = await sendMessage<unknown>({ type: "GET_DASHBOARD_STATE" } satisfies RuntimeMessage);
    if (!isDashboardState(response)) throw new Error("Invalid dashboard response");
    renderDashboard(response);
    hasRenderedState = true;
    setView("content");
  } catch {
    setView("error");
    announce(message("dashboardUnavailableAnnouncement", "Mission Control is unavailable. Try again."));
  } finally {
    refreshInFlight = false;
  }
}

function setView(view: "loading" | "error" | "content"): void {
  el.loading.hidden = view !== "loading";
  el.error.hidden = view !== "error";
  el.content.hidden = view === "loading" || (view === "error" && !hasRenderedState);
  el.main.toggleAttribute("aria-busy", view === "loading");
}

function renderDashboard(state: DashboardState): void {
  const summary = getDashboardSummary(state);
  el.activeCount.textContent = String(summary.activeMonitors);
  el.healthyCount.textContent = String(summary.healthyMonitors);
  el.attentionCount.textContent = String(summary.attentionMonitors);
  el.protectedCount.textContent = String(summary.protectedSites);
  renderLastUpdated(state.generatedAt);
  renderSystemNotice(state);
  renderCoverage(state.configuredSites, summary.protectedSites);
  renderMonitors(state.activeMonitors);
  renderRecoveryEvents(state.recentRecoveries);

  const signature = `${summary.activeMonitors}:${summary.healthyMonitors}:${summary.attentionMonitors}:${summary.protectedSites}`;
  if (signature !== lastSummarySignature) {
    lastSummarySignature = signature;
    announce(message(
      "dashboardSummaryAnnouncement",
      `${summary.activeMonitors} active monitors, ${summary.healthyMonitors} healthy, ${summary.attentionMonitors} needing attention, and ${summary.protectedSites} protected sites.`,
      [String(summary.activeMonitors), String(summary.healthyMonitors), String(summary.attentionMonitors), String(summary.protectedSites)]
    ));
  }
}

function renderLastUpdated(timestamp: number): void {
  el.lastUpdated.textContent = formatRelativeTime(timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) el.lastUpdated.dateTime = new Date(timestamp).toISOString();
  else el.lastUpdated.removeAttribute("datetime");
}

function renderSystemNotice(state: DashboardState): void {
  if (!state.acknowledged) {
    el.systemNotice.hidden = false;
    el.systemNoticeTitle.textContent = message("dashboardSetupRequired", "Finish setup to start protection");
    el.systemNoticeDetail.textContent = message("dashboardSetupRequiredDetail", "Open the toolbar popup to review the disclaimer and choose your first site.");
  } else if (!state.enabled) {
    el.systemNotice.hidden = false;
    el.systemNoticeTitle.textContent = message("dashboardProtectionOff", "Protection is globally disabled");
    el.systemNoticeDetail.textContent = message("dashboardProtectionOffDetail", "Existing site configuration is preserved. Turn protection on from the toolbar popup or Settings.");
  } else {
    el.systemNotice.hidden = true;
    el.systemNoticeTitle.textContent = "";
    el.systemNoticeDetail.textContent = "";
  }
}

function renderCoverage(sites: DashboardConfiguredSite[], protectedSites: number): void {
  const visibleSites = sites.slice(0, MAX_RENDERED_SITES);
  el.configuredSites.replaceChildren(...visibleSites.map(createSiteItem));
  el.configuredSitesEmpty.hidden = sites.length !== 0;
  const total = sites.length;
  const coverageText = message(
    "dashboardCoverageCount",
    `${protectedSites} of ${total} protected`,
    [String(protectedSites), String(total)]
  );
  el.coverageSummary.textContent = coverageText;
  el.coverageProgress.max = Math.max(1, total);
  el.coverageProgress.value = Math.min(protectedSites, el.coverageProgress.max);
  el.coverageProgress.setAttribute("aria-valuetext", coverageText);
}

function createSiteItem(site: DashboardConfiguredSite): HTMLLIElement {
  const item = document.createElement("li");
  const host = document.createElement("span");
  host.className = "site-host";
  host.textContent = privacySafeSiteLabel(site.host, site.origin);

  const status = document.createElement("span");
  status.className = "coverage-status";
  if (site.enabled && site.permissionGranted) {
    status.classList.add("protected");
    status.textContent = message("dashboardCoverageProtected", "Protected");
  } else if (site.enabled) {
    status.classList.add("access-needed");
    status.textContent = message("dashboardCoverageAccessNeeded", "Access needed");
  } else {
    status.classList.add("off");
    status.textContent = message("dashboardCoverageOff", "Off");
  }

  const tabs = document.createElement("span");
  tabs.className = "site-tabs";
  const activeTabs = Math.max(0, Math.floor(site.activeTabs));
  tabs.textContent = activeTabs === 1
    ? message("dashboardOneActiveTab", "1 active tab")
    : message("dashboardActiveTabCount", `${activeTabs} active tabs`, String(activeTabs));
  item.append(host, status, tabs);
  return item;
}

function renderMonitors(monitors: DashboardActiveMonitor[]): void {
  const visibleMonitors = monitors.slice(0, MAX_RENDERED_MONITORS);
  el.activeMonitors.replaceChildren(...visibleMonitors.map(createMonitorCard));
  el.activeMonitorsEmpty.hidden = monitors.length !== 0;
}

function createMonitorCard(monitor: DashboardActiveMonitor): HTMLElement {
  const presentation = getMonitorPresentation(monitor.state);
  const safeHost = privacySafeSiteLabel(monitor.host, monitor.origin);
  const card = document.createElement("article");
  card.className = "monitor-card";

  const header = document.createElement("div");
  header.className = "monitor-card-header";
  const title = document.createElement("h3");
  title.textContent = safeHost;
  const status = document.createElement("span");
  status.className = `status-chip tone-${presentation.tone}`;
  status.textContent = message(presentation.i18nKey, presentation.label);
  header.append(title, status);

  const detail = document.createElement("p");
  detail.className = "monitor-detail";
  detail.textContent = privacySafeDetail(monitor.detail, monitor.state);

  const metadata = document.createElement("dl");
  metadata.className = "monitor-meta";
  addDefinition(metadata, message("dashboardConfidence", "Confidence"), formatConfidence(monitor.confidence));
  addDefinition(
    metadata,
    message("dashboardRecoveryStep", "Recovery step"),
    monitor.recoveryAction ? recoveryActionLabel(monitor.recoveryAction) : message("dashboardNoRecoveryStep", "None")
  );
  addDefinition(metadata, message("dashboardLastCheck", "Last check"), formatRelativeTime(monitor.updatedAt));

  const focus = document.createElement("button");
  focus.type = "button";
  focus.className = "focus-tab";
  focus.textContent = message("dashboardFocusTab", "Focus tab");
  focus.setAttribute("aria-label", message("dashboardFocusSiteTab", `Focus the ${safeHost} tab`, safeHost));
  focus.addEventListener("click", () => void focusDashboardTab(monitor.tabId, safeHost, focus));
  card.append(header, detail, metadata, focus);
  return card;
}

function addDefinition(list: HTMLDListElement, termText: string, detailText: string): void {
  const group = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = termText;
  detail.textContent = detailText;
  group.append(term, detail);
  list.append(group);
}

function renderRecoveryEvents(events: DashboardRecoveryEvent[]): void {
  const visibleEvents = events.slice(0, MAX_RENDERED_RECOVERIES);
  el.recentRecoveries.replaceChildren(...visibleEvents.map(createRecoveryEvent));
  el.recentRecoveriesEmpty.hidden = events.length !== 0;
}

function createRecoveryEvent(event: DashboardRecoveryEvent): HTMLLIElement {
  const item = document.createElement("li");
  const title = document.createElement("div");
  title.className = "event-title";
  const host = document.createElement("strong");
  host.textContent = privacySafeSiteLabel(event.host, event.origin);
  const action = document.createElement("span");
  action.textContent = recoveryActionLabel(event.action);
  title.append(host, action);

  const outcome = document.createElement("span");
  outcome.className = `outcome-chip outcome-${event.outcome}`;
  outcome.textContent = recoveryOutcomeLabel(event.outcome);
  const time = document.createElement("time");
  time.className = "event-time";
  time.textContent = formatRelativeTime(event.timestamp);
  if (Number.isFinite(event.timestamp) && event.timestamp > 0) time.dateTime = new Date(event.timestamp).toISOString();
  item.append(title, outcome, time);
  return item;
}

async function focusDashboardTab(tabId: number, safeHost: string, button: HTMLButtonElement): Promise<void> {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  button.disabled = true;
  try {
    const response = await sendMessage<{ ok?: boolean }>({ type: "FOCUS_DASHBOARD_TAB", tabId } satisfies RuntimeMessage);
    if (response?.ok !== true) throw new Error("Tab focus failed");
    announce(message("dashboardFocusedTab", `Focused the ${safeHost} tab.`, safeHost));
  } catch {
    announce(message("dashboardFocusFailed", "That monitored tab is no longer available."));
  } finally {
    button.disabled = false;
  }
}

function formatConfidence(value: number): string {
  const percentage = Math.round(Math.min(100, Math.max(0, value)));
  return `${percentage}%`;
}

function announce(value: string): void {
  if (el.announcer.textContent === value) el.announcer.textContent = "";
  window.requestAnimationFrame(() => { el.announcer.textContent = value; });
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
