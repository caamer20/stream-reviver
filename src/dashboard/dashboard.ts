import { sendMessage, ext } from "../shared/api";
import { localizeDocument, message } from "../shared/i18n";
import type { RuntimeMessage } from "../shared/types";
import {
  formatRelativeTime,
  filterDashboardState,
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
  type DashboardFilters,
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
  staleNotice: byId("stale-notice"),
  search: byId<HTMLInputElement>("dashboard-search"),
  siteFilter: byId<HTMLSelectElement>("site-filter"),
  monitorFilter: byId<HTMLSelectElement>("monitor-filter"),
  clearFilters: byId<HTMLButtonElement>("clear-filters"),
  siteCount: byId("configured-sites-count"),
  monitorCount: byId("active-monitors-count"),
  recoveryCount: byId("recent-recoveries-count"),
  moreSites: byId<HTMLButtonElement>("show-more-sites"),
  moreMonitors: byId<HTMLButtonElement>("show-more-monitors"),
  moreRecoveries: byId<HTMLButtonElement>("show-more-recoveries"),
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
let latestState: DashboardState | null = null;
let stale = false;
let staleFocusKey: string | undefined;
const visibleLimits = { sites: MAX_RENDERED_SITES, monitors: MAX_RENDERED_MONITORS, recoveries: MAX_RENDERED_RECOVERIES };
const focusingMonitors = new Set<string>();

localizeDocument();
try { document.documentElement.lang = ext.i18n?.getUILanguage?.() || "en"; } catch { /* The declared English fallback remains. */ }
el.retry.addEventListener("click", () => void refreshDashboard(true));
el.search.addEventListener("input", applyFilters);
el.siteFilter.addEventListener("change", applyFilters);
el.monitorFilter.addEventListener("change", applyFilters);
el.clearFilters.addEventListener("click", () => {
  el.search.value = "";
  el.siteFilter.value = "all";
  el.monitorFilter.value = "all";
  applyFilters();
  el.search.focus();
});
for (const [button, key, batch] of [
  [el.moreSites, "sites", MAX_RENDERED_SITES],
  [el.moreMonitors, "monitors", MAX_RENDERED_MONITORS],
  [el.moreRecoveries, "recoveries", MAX_RENDERED_RECOVERIES]
] as const) {
  button.addEventListener("click", () => {
    visibleLimits[key] += batch;
    renderLists();
    if (button.hidden) {
      const target = key === "sites" ? el.siteFilter : key === "monitors" ? el.monitorFilter : el.search;
      target.focus();
    }
    announceListCounts();
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshDashboard(false);
});
void initialize();

async function initialize(): Promise<void> {
  await refreshDashboard(true);
  window.setInterval(() => void refreshDashboard(false), POLL_INTERVAL_MS);
}

async function refreshDashboard(showLoading: boolean): Promise<void> {
  if (!showLoading && document.visibilityState !== "visible") return;
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (showLoading && !hasRenderedState) setView("loading");
  try {
    const response = await sendMessage<unknown>({ type: "GET_DASHBOARD_STATE" } satisfies RuntimeMessage);
    if (!isDashboardState(response)) throw new Error("Invalid dashboard response");
    latestState = response;
    stale = false;
    renderDashboard(response);
    hasRenderedState = true;
    setView("content");
  } catch {
    stale = true;
    const focusedAction = document.activeElement?.matches(".focus-tab");
    if (focusedAction) staleFocusKey = (document.activeElement?.closest(".monitor-card") as HTMLElement)?.dataset.monitorKey;
    el.activeMonitors.querySelectorAll<HTMLButtonElement>(".focus-tab").forEach((button) => { button.disabled = true; });
    setView("error");
    if (focusedAction && document.visibilityState === "visible") el.retry.focus();
    announce(message("dashboardUnavailableAnnouncement", "Mission Control is unavailable. Try again."));
  } finally {
    refreshInFlight = false;
  }
}

function setView(view: "loading" | "error" | "content"): void {
  const restoreErrorFocus = view === "content" && el.error.contains(document.activeElement);
  el.loading.hidden = view !== "loading";
  el.error.hidden = view !== "error";
  el.content.hidden = view === "loading" || (view === "error" && !hasRenderedState);
  el.staleNotice.hidden = view !== "error" || !hasRenderedState;
  el.main.toggleAttribute("aria-busy", view === "loading");
  if (restoreErrorFocus && document.visibilityState === "visible") {
    const card = Array.from(el.activeMonitors.children).find((item) => (item as HTMLElement).dataset.monitorKey === staleFocusKey);
    const button = card?.querySelector<HTMLButtonElement>(".focus-tab");
    (button && !button.disabled ? button : el.monitorFilter).focus({ preventScroll: true });
  }
  if (view === "content") staleFocusKey = undefined;
}

function renderDashboard(state: DashboardState): void {
  const summary = getDashboardSummary(state);
  el.activeCount.textContent = String(summary.activeMonitors);
  el.healthyCount.textContent = String(summary.healthyMonitors);
  el.attentionCount.textContent = String(summary.attentionMonitors);
  el.protectedCount.textContent = String(summary.protectedSites);
  renderLastUpdated(state.generatedAt);
  renderSystemNotice(state);
  renderCoverageSummary(state.configuredSites.length, summary.protectedSites);
  renderLists();

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

function renderCoverageSummary(total: number, protectedSites: number): void {
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

function getFilters(): DashboardFilters {
  return {
    query: el.search.value,
    siteStatus: el.siteFilter.value as DashboardFilters["siteStatus"],
    monitorStatus: el.monitorFilter.value as DashboardFilters["monitorStatus"]
  };
}

function applyFilters(): void {
  visibleLimits.sites = MAX_RENDERED_SITES;
  visibleLimits.monitors = MAX_RENDERED_MONITORS;
  visibleLimits.recoveries = MAX_RENDERED_RECOVERIES;
  renderLists();
  announceListCounts();
}

function announceListCounts(): void {
  if (!latestState) return;
  const filtered = filterDashboardState(latestState, getFilters());
  announce(message("dashboardFilterAnnouncement", `${filtered.configuredSites.length} matching sites, ${filtered.activeMonitors.length} matching streams, and ${filtered.recentRecoveries.length} matching events.`,
    [String(filtered.configuredSites.length), String(filtered.activeMonitors.length), String(filtered.recentRecoveries.length)]));
}

function renderLists(): void {
  if (!latestState) return;
  const filtered = filterDashboardState(latestState, getFilters());
  const sites = filtered.configuredSites.slice(0, visibleLimits.sites);
  el.configuredSites.replaceChildren(...sites.map(createSiteItem));
  renderListStatus(el.configuredSitesEmpty, el.siteCount, el.moreSites, sites.length, filtered.configuredSites.length,
    latestState.configuredSites.length, "dashboardNoSites", "No sites are configured yet. Enable a site from the toolbar popup to see it here.");
  renderMonitors(filtered.activeMonitors);
  renderListStatus(el.activeMonitorsEmpty, el.monitorCount, el.moreMonitors, Math.min(visibleLimits.monitors, filtered.activeMonitors.length), filtered.activeMonitors.length,
    latestState.activeMonitors.length, "dashboardNoMonitors", "No active streams right now. Open a configured site to begin monitoring.");
  const events = filtered.recentRecoveries.slice(0, visibleLimits.recoveries);
  el.recentRecoveries.replaceChildren(...events.map(createRecoveryEvent));
  renderListStatus(el.recentRecoveriesEmpty, el.recoveryCount, el.moreRecoveries, events.length, filtered.recentRecoveries.length,
    latestState.recentRecoveries.length, "dashboardNoRecoveries", "No recent recovery events. Quiet is good.");
}

function renderListStatus(empty: HTMLElement, count: HTMLElement, more: HTMLButtonElement, shown: number, matching: number, total: number, emptyKey: string, emptyFallback: string): void {
  empty.hidden = matching !== 0;
  empty.textContent = total === 0 ? message(emptyKey, emptyFallback)
    : message("dashboardNoMatches", "No matches. Try another hostname or clear the filters.");
  count.textContent = message("dashboardShowingCount", `Showing ${shown} of ${matching}`, [String(shown), String(matching)]);
  more.hidden = shown >= matching;
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
  const visibleMonitors = monitors.slice(0, visibleLimits.monitors);
  const focused = document.activeElement instanceof HTMLButtonElement && document.activeElement.matches(".focus-tab")
    ? document.activeElement : null;
  const existing = new Map(Array.from(el.activeMonitors.children).map((card) => [(card as HTMLElement).dataset.monitorKey, card as HTMLElement]));
  let cursor = el.activeMonitors.firstElementChild;
  for (const monitor of visibleMonitors) {
    const key = monitorKey(monitor);
    const card = existing.get(key) ?? createMonitorCard(monitor);
    updateMonitorCard(card, monitor);
    if (card !== cursor) el.activeMonitors.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
    existing.delete(key);
  }
  for (const card of existing.values()) card.remove();
  if (focused && document.visibilityState === "visible") {
    if (!focused.isConnected) el.monitorFilter.focus();
    else if (document.activeElement !== focused && !focused.disabled) focused.focus({ preventScroll: true });
  }
}

function createMonitorCard(monitor: DashboardActiveMonitor): HTMLElement {
  const card = document.createElement("article");
  card.className = "monitor-card";
  card.dataset.monitorKey = monitorKey(monitor);

  const header = document.createElement("div");
  header.className = "monitor-card-header";
  const title = document.createElement("h3");
  const status = document.createElement("span");
  status.className = "status-chip";
  header.append(title, status);

  const detail = document.createElement("p");
  detail.className = "monitor-detail";

  const metadata = document.createElement("dl");
  metadata.className = "monitor-meta";

  const focus = document.createElement("button");
  focus.type = "button";
  focus.className = "focus-tab";
  focus.textContent = message("dashboardFocusTab", "Focus tab");
  focus.addEventListener("click", () => void focusDashboardTab(monitor.tabId, privacySafeSiteLabel(monitor.host, monitor.origin), focus, monitorKey(monitor)));
  card.append(header, detail, metadata, focus);
  return card;
}

function monitorKey(monitor: DashboardActiveMonitor): string {
  return `${monitor.tabId}:${monitor.origin}`;
}

function updateMonitorCard(card: HTMLElement, monitor: DashboardActiveMonitor): void {
  const presentation = getMonitorPresentation(monitor.state);
  const safeHost = privacySafeSiteLabel(monitor.host, monitor.origin);
  card.querySelector("h3")!.textContent = safeHost;
  const status = card.querySelector<HTMLElement>(".status-chip")!;
  status.className = `status-chip tone-${presentation.tone}`;
  status.textContent = message(presentation.i18nKey, presentation.label);
  card.querySelector(".monitor-detail")!.textContent = privacySafeDetail(monitor.detail, monitor.state);
  const metadata = card.querySelector<HTMLDListElement>(".monitor-meta")!;
  metadata.replaceChildren();
  addDefinition(metadata, message("dashboardConfidence", "Confidence"), formatConfidence(monitor.confidence));
  addDefinition(metadata, message("dashboardRecoveryStep", "Recovery step"), monitor.recoveryAction ? recoveryActionLabel(monitor.recoveryAction) : message("dashboardNoRecoveryStep", "None"));
  addDefinition(metadata, message("dashboardLastCheck", "Last check"), formatRelativeTime(monitor.updatedAt));
  const focus = card.querySelector<HTMLButtonElement>(".focus-tab")!;
  focus.setAttribute("aria-label", message("dashboardFocusSiteTab", `Focus the ${safeHost} tab`, safeHost));
  focus.disabled = stale || focusingMonitors.has(monitorKey(monitor));
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

async function focusDashboardTab(tabId: number, safeHost: string, button: HTMLButtonElement, key: string): Promise<void> {
  if (stale || focusingMonitors.has(key) || !Number.isInteger(tabId) || tabId < 0) return;
  focusingMonitors.add(key);
  button.disabled = true;
  try {
    const response = await sendMessage<{ ok?: boolean }>({ type: "FOCUS_DASHBOARD_TAB", tabId } satisfies RuntimeMessage);
    if (response?.ok !== true) throw new Error("Tab focus failed");
    announce(message("dashboardFocusedTab", `Focused the ${safeHost} tab.`, safeHost));
  } catch {
    announce(message("dashboardFocusFailed", "That monitored tab is no longer available."));
  } finally {
    focusingMonitors.delete(key);
    button.disabled = stale;
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
