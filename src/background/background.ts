import { addAsyncMessageListener, apiCall, ext, getOrigin, originPattern, queryActiveTab, sendTabMessage, sharesEnabledOriginPermission } from "../shared/api";
import { authorizeRuntimeMessage } from "../shared/authorization";
import { installProtocolBridge } from "../page-bridge/bridge";
import { effectiveSettings, getDisclaimerAcknowledged, getSettings, getVisualPrivacyAcknowledged, isUrlEnabled, restrictLocalStorageAccess, SETTINGS_STORAGE_KEYS, setDisclaimerAcknowledged, setSettings, setVisualPrivacyAcknowledged } from "../shared/settings";
import { addActionOutcome, addHealthSample, addSession, addUserFeedback, emptySiteModel } from "../shared/outcomes";
import { normalizeProfile } from "../shared/profiles";
import { healthyDiagnosis } from "../shared/diagnosis";
import { loopUrlKey as urlKey, normalizeLoopEntry as normalizedLoopEntry, type LoopEntry } from "../shared/loop-policy";
import { validateAutomaticRecoverySetting } from "../shared/policy";
import { PrimaryLeaseRegistry } from "./primary-lease";
import {
  RecoveryCoordinator, actionLimit, emptyRecoveryStore, type ActionBudget,
  type ExpiredRecoveryAction, type RecoveryActionRecord, type RecoveryLedgerStore, type RecoveryOwnerMatch
} from "./recovery-coordinator";
import { decideVisualSampleAccess, hashCapturedVisual, MIN_VISUAL_SAMPLE_INTERVAL_MS } from "./visual-watchdog";
import { dashboardHost, dashboardRecoveryEvents, dashboardSafeDetail, dashboardStateRank } from "./dashboard-state";
import { frameIdsForOrigin } from "./frame-routing";
import { navigationBindingKey } from "./navigation-binding";
import type {
  DashboardActiveMonitor, DashboardState, DataClearTarget, EffectiveSettings, FrameStatus,
  GlobalSettings, HistoryEvent, LocalSiteModel, MonitorState, PlayerPreferences,
  PlayerSessionSnapshot, PopupState, RecoveryAction, RecoveryActionAuthorization, RuntimeMessage, SelectorField,
  SelectorValidationResult, Settings, SiteProfile, SiteSettings
} from "../shared/types";

const REGISTRATION_PREFIX = "stream_reviver_";
const BRIDGE_REGISTRATION_PREFIX = "stream_reviver_bridge_";
const LOOP_KEY = "streamReviverLoopStateV2";
const HISTORY_KEY = "streamReviverHistoryV2";
const PREFERENCES_KEY = "streamReviverPlayerPreferencesV2";
const STATUS_KEY = "streamReviverStatusV2";
const PROFILE_KEY = "streamReviverProfilesV3";
const SITE_MODEL_KEY = "streamReviverSiteModelsV3";
const SNAPSHOT_KEY = "streamReviverSessionSnapshotsV3";
const SESSION_SEEN_KEY = "streamReviverSessionVisitsV3";
const RECOVERY_LEDGER_KEY = "streamReviverRecoveryLedgerV4";
const RECOVERY_ALARM_PREFIX = "stream-reviver-recovery:";
const MAX_PENDING_AGE = 2 * 60_000;
const COUNTDOWN_COMMIT_GRACE_MS = 5_000;

interface TabRuntimeState {
  frames: Map<number, FrameStatus>;
  countdownSourceFrame?: number;
  lastHistoryKey?: string;
}
type LoopStore = Record<string, LoopEntry>;
type StatusStore = Record<string, FrameStatus>;
interface StoredSessionSnapshot {
  tabId: number;
  frameId: number;
  navigationId: string;
  recoveryCycleId: string;
  pageUrlKey: string;
  savedAt: number;
  deliveredAt?: number | null;
  snapshot: PlayerSessionSnapshot;
}
type SessionSnapshotStore = Record<string, StoredSessionSnapshot>;

const runtimeTabs = new Map<number, TabRuntimeState>();
const primaryLeases = new PrimaryLeaseRegistry();
const recoveryCoordinator = new RecoveryCoordinator({ load: getRecoveryLedgerStore, save: setRecoveryLedgerStore });
const protectedTabs = new Set<number>();
const visualSampleInFlight = new Set<number>();
const visualLastSampleAt = new Map<number, number>();
const topNavigationRevisions = new Map<number, number>();
const topNavigationInProgress = new Set<number>();
const tabControlMutationCounts = new Map<number, number>();
let loopQueue: Promise<void> = Promise.resolve();
let historyQueue: Promise<void> = Promise.resolve();
let registrationQueue: Promise<void> = Promise.resolve();
let snapshotQueue: Promise<void> = Promise.resolve();
let settingsCache: Settings | null = null;
let clearingAllData = false;

ext.runtime.onInstalled.addListener((details) => void initialize(details.reason === "install"));
ext.runtime.onStartup?.addListener(() => void initialize(false));
ext.tabs.onRemoved.addListener((tabId) => {
  runtimeTabs.delete(tabId);
  primaryLeases.removeTab(tabId);
  protectedTabs.delete(tabId);
  visualSampleInFlight.delete(tabId);
  visualLastSampleAt.delete(tabId);
  topNavigationRevisions.delete(tabId);
  topNavigationInProgress.delete(tabId);
  tabControlMutationCounts.delete(tabId);
  void finalizeRemovedTab(tabId);
});
ext.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    topNavigationRevisions.set(tabId, (topNavigationRevisions.get(tabId) ?? 0) + 1);
    if (changeInfo.status === "loading") {
      topNavigationInProgress.add(tabId);
      runtimeTabs.delete(tabId);
      primaryLeases.removeTab(tabId);
    }
    // Queue the durable cancellation immediately, before any alarm callback
    // can consume the same one-use authorization.
    void cancelPendingRecoveryAfterTopLevelNavigation(
      tabId,
      changeInfo.url ? "The tab navigated away before the scheduled recovery" :
        "The page started another navigation before the scheduled recovery"
    );
  }
  if (changeInfo.status === "complete") topNavigationInProgress.delete(tabId);
});
ext.alarms?.onAlarm.addListener((alarm) => {
  const parsed = parseRecoveryAlarmName(alarm.name);
  if (parsed) void executeScheduledRecovery(parsed.tabId, parsed.actionId);
});
ext.storage.onChanged.addListener((changes, areaName) => {
  const settingsChanged = (areaName === "sync" && !!changes[SETTINGS_STORAGE_KEYS.global])
    || (areaName === "local" && !!changes[SETTINGS_STORAGE_KEYS.sites]);
  if (settingsChanged) {
    settingsCache = null;
    if (clearingAllData) return;
    void loadSettings().then(async (settings) => {
      await syncRegistrations();
      await broadcastSettings(settings);
    }).catch(() => undefined);
  }
});
ext.permissions?.onRemoved.addListener((permissions) => { if (!clearingAllData) void reconcileRemovedPermissions(permissions.origins ?? []); });
ext.permissions?.onAdded.addListener((permissions) => void reconcileAddedPermissions(permissions.origins ?? []));
ext.commands?.onCommand.addListener((command) => void handleCommand(command));

addAsyncMessageListener(async (message: RuntimeMessage, sender) => {
  const senderUrl = sender.url ?? null;
  const extensionPage = sender.id === ext.runtime.id && !!senderUrl?.startsWith(ext.runtime.getURL(""));
  const contentScript = sender.id === ext.runtime.id && sender.tab?.id !== undefined && !extensionPage;
  const authorization = authorizeRuntimeMessage(message, { extensionPage, contentScript, senderUrl, tabId: sender.tab?.id ?? null });
  if (!authorization.ok) return { ok: false, error: authorization.error };
  switch (message.type) {
    case "GET_CONTEXT": return getContentContext(message.origin, message.pageUrl, message.navigationId, sender.tab?.id, sender.frameId ?? 0);
    case "GET_POPUP_STATE": return getPopupState(message.tabId, message.origin);
    case "GET_DASHBOARD_STATE": return getDashboardState();
    case "FOCUS_DASHBOARD_TAB": return focusDashboardTab(message.tabId);
    case "GET_HISTORY": return getHistory(message.tabId, message.limit ?? 200);
    case "GET_SITE_MODEL": return getSiteModel(message.origin);
    case "GET_PROFILES": return getProfiles();
    case "SAVE_PROFILE": return saveProfile(message.profile);
    case "DELETE_PROFILE": return deleteProfile(message.profileId);
    case "CLEAR_HISTORY": return clearHistory(message.tabId);
    case "CLEAR_DATA": return clearData(message.target);
    case "GET_PRIVACY_STATE": return { visualPrivacyAcknowledged: await getVisualPrivacyAcknowledged() };
    case "ACKNOWLEDGE_VISUAL_PRIVACY": await setVisualPrivacyAcknowledged(true); return { ok: true };
    case "ACKNOWLEDGE_DISCLAIMER": await setDisclaimerAcknowledged(true); return { ok: true };
    case "UPDATE_GLOBAL_SETTINGS": return updateGlobalSettings(message.patch);
    case "SET_SITE_ENABLED": return setSiteEnabled(message.origin, message.enabled, message.tabId);
    case "SET_SITE_OVERRIDES": return setSiteOverrides(message.origin, message.overrides, message.replace === true);
    case "SAVE_SITE_SELECTOR": return saveSiteSelector(message.origin, message.field, message.selector, sender.tab?.id ?? message.tabId);
    case "VALIDATE_SITE_SELECTOR": return validateSiteSelector(message.origin, message.field, message.selector);
    case "REPORT_STATUS": return recordFrameStatus(sender, message.status);
    case "LOG_HISTORY": return appendHistory({ ...message.entry, tabId: sender.tab?.id, frameId: sender.frameId });
    case "REQUEST_AUTO_REFRESH": return requestAutoRefresh(sender, message.origin, message.pageUrl, message.reason, message.confidence);
    case "RECORD_AUTO_REFRESH": return recordAutoRefresh(sender, message.origin, message.pageUrl);
    case "AUTHORIZE_RECOVERY_ACTION": return authorizeRecoveryAction(sender, message);
    case "COMMIT_RECOVERY_ACTION": return commitRecoveryAction(sender, message);
    case "COMPLETE_RECOVERY_ACTION": return completeRecoveryAction(sender, message);
    case "EXTEND_AUTO_REFRESH": return extendAutoRefresh(sender, message);
    case "CANCEL_AUTO_REFRESH": return cancelAutoRefresh(sender.tab?.id, message, sender.frameId ?? 0);
    case "PLAYBACK_SUCCESS": return clearAfterSuccess(sender, message.pageUrl, message.recoveryCycleId);
    case "RECORD_ACTION_OUTCOME": return recordActionOutcome(message.origin, message.outcome);
    case "RECORD_HEALTH_SAMPLE": return recordHealthSample(message.origin, message.sample);
    case "RECORD_USER_FEEDBACK": return recordUserFeedback(message.origin, message.correct, message.failureKind);
    case "SAVE_SESSION_SNAPSHOT": return saveSessionSnapshot(sender, message.snapshot);
    case "CLEAR_SESSION_SNAPSHOT": return clearSessionSnapshot(sender, message.origin, message.recoveryCycleId);
    case "CLAIM_AUTO_MAXIMIZE": return claimAutoMaximize(sender, message.pageUrl, message.recoveryCycleId);
    case "SAVE_PLAYER_PREFERENCES": return savePreferences(message.origin, message.preferences);
    case "REQUEST_PARENT_MAXIMIZE":
      if (sender.tab?.id !== undefined) await safeSend(sender.tab.id, { type: "MAXIMIZE_IFRAME" });
      return { ok: true };
    case "REQUEST_IFRAME_RECOVERY": return recoverIframe(sender, message.frameToken);
    case "MANUAL_REFRESH": return manualRefresh(message.tabId, message.origin);
    case "MANUAL_MAXIMIZE": return manualMaximize(message.tabId);
    case "MANUAL_PICTURE_IN_PICTURE": return manualPictureInPicture(message.tabId);
    case "MANUAL_JUMP_TO_LIVE": return manualJumpToLive(message.tabId);
    case "PIN_PRIMARY_VIDEO": return startPickerInTab(message.tabId, "selectedVideoSelector");
    case "START_SELECTOR_PICKER": return startSelectorPicker(message.origin, message.field);
    case "CANCEL_SELECTOR_PICKER":
      if (sender.tab?.id !== undefined) await safeSendAll(sender.tab.id, { type: "STOP_ELEMENT_PICKER" });
      return { ok: true };
    case "SNOOZE_TAB": return snoozeTab(message.tabId, message.until);
    case "SET_EVENT_MODE": return setEventMode(message.tabId, message.until);
    case "RESET_TAB_ATTEMPTS": return resetTabAttempts(message.tabId);
    case "EXTEND_COUNTDOWN": return extendTabCountdown(message.tabId, message.seconds);
    case "CANCEL_TAB_COUNTDOWN": return cancelAutoRefresh(message.tabId);
    case "REQUEST_VISUAL_SAMPLE": return captureVisualSample(sender, message);
    default: return { ok: false, error: "Unknown message" };
  }
});

void initialize(false);

async function initialize(firstInstall: boolean): Promise<void> {
  await restrictLocalStorageAccess();
  await syncRegistrations();
  await reconcileExpiredRecoveries();
  await restoreRecoveryAlarms();
  if (firstInstall) {
    try { await apiCall<chrome.tabs.Tab>(ext.tabs.create, ext.tabs, { url: ext.runtime.getURL("welcome.html") }); }
    catch { /* popup retains the acknowledgement gate */ }
  }
}

async function loadSettings(force = false): Promise<Settings> {
  if (!force && settingsCache) return settingsCache;
  settingsCache = await getSettings();
  return settingsCache;
}

async function getContentContext(origin: string, pageUrl: string, navigationId: string, tabId?: number, frameId = 0) {
  const [settings, acknowledged] = await Promise.all([loadSettings(), getDisclaimerAcknowledged()]);
  const effective = effectiveSettings(settings, origin);
  // Browser host grants can cover sibling ports. Do not create session/model
  // records for those origins unless the user explicitly enabled them.
  if (!effective.siteEnabled) return {
    acknowledged, settings: effective, pendingAutoMaximize: false,
    pendingAutoMaximizeUntil: null, siteModel: null, recoveryResume: null
  };
  if (acknowledged && effective.enabled && effective.enableAdvancedPlayerBridge &&
      isUrlEnabled(pageUrl, effective) && tabId !== undefined) {
    await apiCall(ext.scripting.executeScript, ext.scripting, {
      target: { tabId, frameIds: [frameId] }, world: "MAIN",
      func: installProtocolBridge, args: [origin]
    }).catch(() => undefined); // Unsupported/restricted MAIN worlds fail closed.
  }
  const pageUrlBindingKey = await navigationBindingKey(pageUrl) ?? "";
  const [loops, preferences, snapshots, recoveryResume] = await Promise.all([
    getLoopStore(), getPreferencesStore(), getSessionSnapshots()
    , tabId === undefined ? Promise.resolve(null) : recoveryCoordinator.resume(tabId, frameId, origin, pageUrlBindingKey, navigationId)
  ]);
  const siteModel = tabId === undefined ? await getSiteModel(origin) : await recordSessionVisit(origin, tabId);
  const entry = tabId === undefined ? undefined : loops[String(tabId)];
  const pendingMaximizeAt = effective.enabled && effective.siteEnabled && effective.autoMaximize &&
    recoveryResume && entry?.pendingMaximizeAt && Date.now() - entry.pendingMaximizeAt < MAX_PENDING_AGE
    ? entry.pendingMaximizeAt : null;
  return {
    acknowledged,
    settings: effective,
    // Keep the boolean for staged upgrades with an older content bundle. The
    // absolute deadline lets the current bundle retry a transient lease or
    // worker wake-up miss without leaving the request armed indefinitely.
    pendingAutoMaximize: pendingMaximizeAt !== null,
    pendingAutoMaximizeUntil: pendingMaximizeAt === null ? null : pendingMaximizeAt + MAX_PENDING_AGE,
    preferences: effective.restorePlayerPreferences ? preferences[origin] : undefined,
    snoozedUntil: entry?.snoozedUntil ?? null,
    eventModeUntil: entry?.eventModeUntil ?? null,
    siteModel,
    // A numeric frame ID may be reused for a different embed after a top-level
    // reload. Recovery snapshots are therefore withheld until the fresh
    // primary lease wins and adopts the durable transaction.
    sessionSnapshot: effective.restorePlayerPreferences && !recoveryResume
      ? findSessionSnapshot(snapshots, tabId, frameId, pageUrl) : undefined,
    recoveryResume
  };
}

async function getPopupState(tabId?: number, requestedOrigin?: string): Promise<PopupState> {
  const [settings, acknowledged, loops, models] = await Promise.all([loadSettings(), getDisclaimerAcknowledged(), getLoopStore(), getSiteModels()]);
  let origin = requestedOrigin ?? null;
  if (!origin && tabId !== undefined) {
    try { origin = getOrigin((await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)).url); } catch { origin = null; }
  }
  let status = tabId === undefined ? undefined : selectBestStatus(tabId);
  if (!status && tabId !== undefined) {
    const persisted = (await getStatusStore())[String(tabId)];
    if (persisted && Date.now() - persisted.updatedAt <= 45_000) status = persisted;
    else if (persisted) await removePersistedStatus(tabId);
  }
  const entry = tabId === undefined ? undefined : loops[String(tabId)];
  const windowMs = origin ? effectiveSettings(settings, origin).refreshWindowMinutes * 60_000 : 10 * 60_000;
  return {
    acknowledged, origin, supportedPage: origin !== null, settings,
    effective: origin ? effectiveSettings(settings, origin) : null,
    status: status ?? defaultStatus(settings, origin),
    recentHistory: await getHistory(tabId, 5),
    snoozedUntil: entry?.snoozedUntil ?? null,
    refreshAttempts: entry?.attempts.filter((time) => Date.now() - time < windowMs).length ?? 0,
    eventModeUntil: entry?.eventModeUntil ?? null,
    siteModel: origin ? models[origin] ?? null : null
  };
}

async function getDashboardState(): Promise<DashboardState> {
  const generatedAt = Date.now();
  const [settings, acknowledged, persisted, history, granted] = await Promise.all([
    loadSettings(), getDisclaimerAcknowledged(), getStatusStore(), getHistory(undefined, 1_000),
    apiCall<chrome.permissions.Permissions>(ext.permissions.getAll, ext.permissions)
      .catch((): chrome.permissions.Permissions => ({}))
  ]);

  const statusByTab = new Map<number, FrameStatus>();
  for (const tabId of [...runtimeTabs.keys()]) {
    const status = selectBestStatus(tabId);
    if (status && isFreshDashboardStatus(status, generatedAt)) statusByTab.set(tabId, status);
  }
  for (const [rawTabId, status] of Object.entries(persisted)) {
    const tabId = Number(rawTabId);
    if (!Number.isInteger(tabId) || tabId < 0 || statusByTab.has(tabId) || !isFreshDashboardStatus(status, generatedAt)) continue;
    statusByTab.set(tabId, status);
  }

  const activeMonitors: DashboardActiveMonitor[] = [...statusByTab.entries()]
    .filter(([, status]) => !!settings.perSite[status.origin]?.enabled)
    .map(([tabId, status]) => ({
      tabId,
      origin: status.origin,
      host: dashboardHost(status.origin),
      state: status.state,
      detail: dashboardSafeDetail(status.detail),
      confidence: Math.max(0, Math.min(100, Number.isFinite(status.confidence) ? status.confidence : 0)),
      recoveryAction: status.recoveryAction,
      updatedAt: status.updatedAt
    }))
    .sort((first, second) => dashboardStateRank(second.state) - dashboardStateRank(first.state)
      || second.updatedAt - first.updatedAt || first.host.localeCompare(second.host))
    .slice(0, 100);

  const tabsPerOrigin = new Map<string, number>();
  for (const monitor of activeMonitors) tabsPerOrigin.set(monitor.origin, (tabsPerOrigin.get(monitor.origin) ?? 0) + 1);
  const grantedOrigins = new Set(granted.origins ?? []);
  const configuredSites = Object.entries(settings.perSite)
    .map(([origin, site]) => {
      const pattern = originPattern(origin);
      return {
        origin,
        host: dashboardHost(origin),
        enabled: site.enabled === true,
        permissionGranted: !!pattern && (grantedOrigins.has(pattern) || grantedOrigins.has("<all_urls>")),
        activeTabs: tabsPerOrigin.get(origin) ?? 0
      };
    })
    .sort((first, second) => Number(second.enabled && second.permissionGranted) - Number(first.enabled && first.permissionGranted)
      || second.activeTabs - first.activeTabs || first.host.localeCompare(second.host))
    .slice(0, 500);

  return {
    acknowledged,
    enabled: settings.enabled,
    generatedAt,
    configuredSites,
    activeMonitors,
    recentRecoveries: dashboardRecoveryEvents(history, statusByTab).slice(0, 50)
  };
}

async function focusDashboardTab(tabId: number): Promise<{ ok: boolean; error?: string }> {
  let status = selectBestStatus(tabId);
  if (!status) {
    const persisted = (await getStatusStore())[String(tabId)];
    if (persisted && isFreshDashboardStatus(persisted, Date.now())) status = persisted;
  }
  if (!status || !isFreshDashboardStatus(status, Date.now())) return { ok: false, error: "That monitored tab is no longer available." };
  const settings = await loadSettings();
  if (!settings.enabled || settings.perSite[status.origin]?.enabled !== true) {
    return { ok: false, error: "That tab is no longer actively monitored." };
  }
  try {
    const tab = await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId);
    await apiCall<chrome.tabs.Tab>(ext.tabs.update, ext.tabs, tabId, { active: true });
    if (tab.windowId !== undefined && ext.windows?.update) {
      await apiCall<chrome.windows.Window>(ext.windows.update, ext.windows, tab.windowId, { focused: true }).catch(() => undefined);
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "That monitored tab is no longer available." };
  }
}

async function updateGlobalSettings(patch: Partial<GlobalSettings>) {
  const settings = await loadSettings();
  settingsCache = await setSettings({ ...settings, ...patch });
  return { ok: true, settings: settingsCache };
}

async function setSiteEnabled(origin: string, enabled: boolean, tabId?: number) {
  const [settings, acknowledged] = await Promise.all([loadSettings(), getDisclaimerAcknowledged()]);
  if (enabled && !acknowledged) return { ok: false, error: "Please acknowledge the disclaimer first." };
  const pattern = originPattern(origin);
  if (!pattern) return { ok: false, error: "This browser page cannot be monitored." };
  settings.perSite[origin] = { ...(settings.perSite[origin] ?? {}), enabled };
  settingsCache = await setSettings(settings);
  const matchingTabIds = await findOriginTabIds(origin, tabId);
  if (enabled) {
    if (!(await hasOriginPermission(pattern))) {
      settings.perSite[origin].enabled = false;
      settingsCache = await setSettings(settings);
      return { ok: false, error: "Site access was not granted." };
    }
    await registerOrigin(origin);
    // Dynamic registrations apply on the next navigation. Explicit injection
    // makes enabling from either the popup or options page immediate.
    await Promise.all(matchingTabIds.map((id) => injectIntoTab(id)));
    await appendHistory({ event: "site-enabled", detail: `Monitoring enabled for ${origin}`, level: "info", url: origin, tabId });
  } else {
    for (const id of matchingTabIds) await removeOriginMonitorsFromTab(id, origin, "Site monitoring was disabled");
    await unregisterOrigin(origin);
    if (!sharesEnabledOriginPermission(settingsCache.perSite, origin)) {
      try { await apiCall<boolean>(ext.permissions.remove, ext.permissions, { origins: [pattern] }); } catch { /* browser UI can revoke */ }
    }
    await appendHistory({ event: "site-disabled", detail: `Monitoring disabled for ${origin}`, level: "info", url: origin, tabId });
  }
  return { ok: true, settings: settingsCache };
}

async function setSiteOverrides(origin: string, overrides: SiteSettings, replace: boolean) {
  const settings = await loadSettings();
  settings.perSite[origin] = replace ? { ...overrides } : { ...(settings.perSite[origin] ?? {}), ...overrides };
  settingsCache = await setSettings(settings);
  return { ok: true, settings: settingsCache };
}

async function saveSiteSelector(origin: string, field: SelectorField, selector: string, tabId?: number) {
  const settings = await loadSettings();
  settings.perSite[origin] = { ...(settings.perSite[origin] ?? {}), [field]: selector };
  settingsCache = await setSettings(settings);
  if (tabId !== undefined) await safeSendAll(tabId, { type: "STOP_ELEMENT_PICKER" });
  await appendHistory({ event: "selector-saved", detail: `${field} saved as ${selector}`, level: "info", url: origin, tabId });
  return { ok: true, selector };
}

async function syncRegistrations(): Promise<void> {
  // A queued storage event may describe a site that was disabled while it
  // waited. Re-read inside the lock so it cannot resurrect stale registrations.
  return withRegistrationLock(async () => syncRegistrationsUnlocked(await loadSettings(true)));
}

async function syncRegistrationsUnlocked(settings: Settings): Promise<void> {
  if (!ext.scripting?.registerContentScripts) return;
  let registered: chrome.scripting.RegisteredContentScript[] = [];
  try { registered = await apiCall(ext.scripting.getRegisteredContentScripts, ext.scripting); } catch { return; }
  const expected = new Set<string>();
  for (const [origin, site] of Object.entries(settings.perSite)) if (site.enabled) {
    expected.add(registrationId(origin));
  }
  const obsolete = registered.map((script) => script.id).filter((id) => id.startsWith(REGISTRATION_PREFIX) && !expected.has(id));
  if (obsolete.length) try { await apiCall<void>(ext.scripting.unregisterContentScripts, ext.scripting, { ids: obsolete }); } catch { /* best effort */ }
  for (const [origin, site] of Object.entries(settings.perSite)) {
    const pattern = originPattern(origin);
    if (site.enabled && pattern && await hasOriginPermission(pattern)) {
      const hasContent = registered.some((script) => script.id === registrationId(origin) &&
        script.matches?.length === 1 && script.matches[0] === pattern);
      if (!hasContent) await registerOriginUnlocked(origin);
    }
  }
}

async function registerOrigin(origin: string): Promise<void> {
  return withRegistrationLock(() => registerOriginUnlocked(origin));
}

async function registerOriginUnlocked(origin: string): Promise<void> {
  if (!ext.scripting?.registerContentScripts) throw new Error("Dynamic content-script registration is unavailable.");
  const pattern = originPattern(origin);
  if (!pattern) throw new Error("Unsupported origin");
  await unregisterOriginUnlocked(origin);
  const base = { id: registrationId(origin), matches: [pattern], js: ["content.js"], css: ["content.css"], allFrames: true, runAt: "document_start" as const };
  try {
    await apiCall<void>(ext.scripting.registerContentScripts, ext.scripting, [{ ...base, persistAcrossSessions: true, matchOriginAsFallback: true } as any]);
  } catch { await apiCall<void>(ext.scripting.registerContentScripts, ext.scripting, [base]); }
}
async function unregisterOrigin(origin: string): Promise<void> {
  return withRegistrationLock(() => unregisterOriginUnlocked(origin));
}
async function unregisterOriginUnlocked(origin: string): Promise<void> {
  if (!ext.scripting?.unregisterContentScripts) return;
  try {
    const registered = await apiCall<chrome.scripting.RegisteredContentScript[]>(ext.scripting.getRegisteredContentScripts, ext.scripting);
    const owned = new Set([registrationId(origin), bridgeRegistrationId(origin)]);
    const ids = registered.filter(script => owned.has(script.id)).map(script => script.id);
    // Firefox rejects the whole batch if even one requested ID is absent.
    if (ids.length) await apiCall<void>(ext.scripting.unregisterContentScripts, ext.scripting, { ids });
  } catch { /* permission revocation can concurrently remove registrations */ }
}
async function withRegistrationLock<T>(operation: () => Promise<T>): Promise<T> {
  const task = registrationQueue.then(operation, operation);
  registrationQueue = task.then(() => undefined, () => undefined);
  return task;
}
async function injectIntoTab(tabId: number): Promise<void> {
  try { await apiCall(ext.scripting.insertCSS, ext.scripting, { target: { tabId, allFrames: true }, files: ["content.css"] }); } catch { /* present */ }
  try { await apiCall(ext.scripting.executeScript, ext.scripting, { target: { tabId, allFrames: true }, files: ["content.js"] }); } catch { /* restricted frames skipped */ }
}
async function findOriginTabIds(origin: string, preferredTabId?: number): Promise<number[]> {
  const ids = new Set<number>();
  const tabs = await apiCall<chrome.tabs.Tab[]>(ext.tabs.query, ext.tabs, {}).catch(() => []);
  for (const tab of tabs) if (tab.id !== undefined && getOrigin(tab.url) === origin) ids.add(tab.id);
  // Once permission has been revoked, tab URLs may no longer be exposed. The
  // in-memory frame registry still lets us stop monitors that reported earlier.
  for (const [id, state] of runtimeTabs) if ([...state.frames.values()].some((status) => status.origin === origin)) ids.add(id);
  if (preferredTabId !== undefined) ids.add(preferredTabId);
  return [...ids];
}

async function removeOriginMonitorsFromTab(tabId: number, origin: string, reason: string): Promise<void> {
  const state = runtimeTabs.get(tabId);
  const topOrigin = await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)
    .then((tab) => getOrigin(tab.url)).catch(() => null);
  const frameIds = frameIdsForOrigin(state?.frames, origin, topOrigin);
  if (!frameIds.length) return;

  await Promise.all(frameIds.map((frameId) => safeSend(tabId, { type: "SHUTDOWN_MONITOR" }, frameId)));
  const pending = (await recoveryCoordinator.getPendingActions()).find((item) =>
    item.tabId === tabId && frameIds.includes(item.action.ownerFrameId));
  if (pending) {
    const canceled = await recoveryCoordinator.cancelCurrent(tabId, reason, {
      cycleId: pending.action.cycleId, actionId: pending.action.id,
      authorizationNonce: pending.action.authorizationNonce
    });
    if (canceled) await clearRecoveryAlarm(canceled.id);
  }

  if (state) {
    for (const frameId of frameIds) {
      const status = state.frames.get(frameId);
      if (status) {
        await reconcileLostRecoveryExecutors(tabId, {
          frameId, navigationId: status.navigationId, candidateId: status.candidateId,
          candidateEpoch: status.candidateEpoch
        }, reason);
      }
      state.frames.delete(frameId);
      primaryLeases.removeFrame(tabId, frameId);
    }
    if (frameIds.includes(state.countdownSourceFrame ?? -1)) state.countdownSourceFrame = undefined;
    state.lastHistoryKey = undefined;
  }

  if (!state?.frames.size) {
    runtimeTabs.delete(tabId);
    primaryLeases.removeTab(tabId);
    await removeTabState(tabId);
    await updateDiscardProtection(tabId, false);
    await setBadge(tabId, "", "#6b7280");
    return;
  }

  const selected = selectBestStatus(tabId);
  if (!selected) return;
  await persistStatus(tabId, selected);
  await updateBadge(tabId, selected);
  const remainingSettings = effectiveSettings(await loadSettings(), selected.origin);
  await updateDiscardProtection(tabId, remainingSettings.protectTabFromDiscard &&
    !["DISABLED", "SITE_NOT_ENABLED"].includes(selected.state));
}
async function hasOriginPermission(pattern: string): Promise<boolean> {
  try { return await apiCall<boolean>(ext.permissions.contains, ext.permissions, { origins: [pattern] }); } catch { return false; }
}

async function reconcileRemovedPermissions(patterns: string[]): Promise<void> {
  if (!patterns.length) return;
  const settings = await loadSettings();
  let changed = false;
  for (const [origin, site] of Object.entries(settings.perSite)) {
    const pattern = originPattern(origin);
    if (!site.enabled || !pattern || !patterns.some((removed) => removed === "<all_urls>" || removed === pattern)) continue;
    site.enabled = false;
    changed = true;
    await unregisterOrigin(origin);
    const tabIds = await findOriginTabIds(origin);
    for (const id of tabIds) await removeOriginMonitorsFromTab(
      id, origin, "Site access was revoked before the recovery executor reported a result"
    );
  }
  if (changed) {
    settingsCache = await setSettings(settings);
    await appendHistory({ event: "permission-revoked", detail: "Browser site access was revoked; affected sites were disabled", level: "warning", url: "" });
  }
}

async function reconcileAddedPermissions(patterns: string[]): Promise<void> {
  if (!patterns.length) return;
  const settings = await loadSettings();
  for (const [origin, site] of Object.entries(settings.perSite)) {
    const pattern = originPattern(origin);
    if (site.enabled && pattern && patterns.some((added) => added === "<all_urls>" || added === pattern)) await registerOrigin(origin).catch(() => undefined);
  }
}

async function recordFrameStatus(sender: chrome.runtime.MessageSender, report: Omit<FrameStatus, "updatedAt">) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false };
  const frameId = sender.frameId ?? 0;
  const tab = getTabState(tabId);
  const now = Date.now();
  const previousStatus = tab.frames.get(frameId);
  const previousLease = primaryLeases.get(tabId, now);
  const playerIdentityChanged = !!previousStatus &&
    (previousStatus.navigationId !== report.navigationId || previousStatus.candidateId !== report.candidateId ||
      previousStatus.candidateEpoch !== report.candidateEpoch);
  const status = { ...report, updatedAt: now };
  tab.frames.set(frameId, status);
  for (const [knownFrameId, knownStatus] of tab.frames) {
    if (now - knownStatus.updatedAt > 45_000) {
      tab.frames.delete(knownFrameId);
      primaryLeases.removeFrame(tabId, knownFrameId);
      await reconcileLostRecoveryExecutors(tabId, {
        frameId: knownFrameId, navigationId: knownStatus.navigationId,
        candidateId: knownStatus.candidateId, candidateEpoch: knownStatus.candidateEpoch
      }, "The recovery executor stopped reporting and its frame route expired");
    }
  }
  const election = primaryLeases.report(tabId, frameId, status, now);
  let replacementAdoption: "ADOPTED" | "WAITING" | "REJECTED" = "REJECTED";
  if (report.recoveryCycleId) {
    replacementAdoption = await recoveryCoordinator.adoptReplacementCandidate({
      tabId, frameId, navigationId: report.navigationId, candidateId: report.candidateId,
      candidateEpoch: report.candidateEpoch, cycleId: report.recoveryCycleId,
      origin: report.origin, elected: election.isOwner
    });
  }
  if (playerIdentityChanged && previousStatus && replacementAdoption === "REJECTED") {
    await reconcileLostRecoveryExecutors(tabId, {
      frameId, navigationId: previousStatus.navigationId, candidateId: previousStatus.candidateId,
      candidateEpoch: previousStatus.candidateEpoch
    }, "The recovery executor changed player identity before reporting a result");
  }
  if (election.isOwner && status.recoveryCycleId) {
    const pageUrlBindingKey = await navigationBindingKey(status.pageUrl) ?? "";
    const adopted = await recoveryCoordinator.adoptPageReloadOwner({
      tabId, frameId, navigationId: status.navigationId, candidateId: status.candidateId,
      candidateEpoch: status.candidateEpoch, cycleId: status.recoveryCycleId,
      origin: status.origin, pageUrl: status.pageUrl, pageUrlBindingKey
    });
    if (adopted) void deliverSessionSnapshotAfterHandoff(tabId, frameId, status, status.recoveryCycleId);
  }
  if (election.changed && previousLease && (!election.lease || previousLease.id !== election.lease.id)) {
    const countdown = await recoveryCoordinator.getCountdown(tabId);
    if (countdown?.ownerFrameId === previousLease.frameId) {
      await cancelScheduledRecovery(tabId, countdown, "Primary-player ownership changed during the visible countdown");
    }
    if (replacementAdoption === "REJECTED") {
      await reconcileLostRecoveryExecutors(tabId, {
        frameId: previousLease.frameId, navigationId: previousLease.navigationId,
        candidateId: previousLease.candidateId, candidateEpoch: previousLease.candidateEpoch
      }, "Primary-player ownership moved to another recovery executor");
    }
  }
  const selected = primaryLeases.ownerStatus(tabId) ?? selectBestStatus(tabId) ?? status;
  await updateBadge(tabId, selected);
  await persistStatus(tabId, selected);
  const historyKey = `${selected.state}:${selected.detail}:${selected.recoveryAction ?? ""}`;
  const effective = effectiveSettings(await loadSettings(), selected.origin);
  const loop = (await getLoopStore())[String(tabId)];
  const eventModeActive = !!loop?.eventModeUntil && loop.eventModeUntil > Date.now();
  if (sender.tab?.id !== undefined) await updateDiscardProtection(sender.tab.id,
    (effective.protectTabFromDiscard || eventModeActive) && selected.state !== "DISABLED" && selected.state !== "SITE_NOT_ENABLED");
  if (effective.localHistoryEnabled && tab.lastHistoryKey !== historyKey) {
    tab.lastHistoryKey = historyKey;
    await appendHistory({
      event: `status-${selected.state.toLowerCase()}`, detail: selected.detail,
      level: statusLevel(selected.state), url: selected.pageUrl, tabId, frameId,
      metadata: {
        confidence: selected.confidence, evidence: selected.evidence, recoveryAction: selected.recoveryAction,
        diagnosis: selected.diagnosis, streamKind: selected.streamKind, liveIntent: selected.liveIntent,
        liveEdgeLagSeconds: selected.liveEdgeLagSeconds, bufferAheadSeconds: selected.bufferAheadSeconds,
        recoveryCycleId: selected.recoveryCycleId, circuitState: selected.circuitState, compatibility: selected.compatibility
      }
    });
  }
  if (election.isOwner && report.state === "HEALTHY") {
    const countdown = await recoveryCoordinator.getCountdown(tabId);
    if (countdown?.ownerFrameId === frameId) {
      tab.countdownSourceFrame = undefined;
      const canceled = await recoveryCoordinator.cancelCurrent(tabId, "Playback recovered before the scheduled reload", {
        cycleId: countdown.cycleId, actionId: countdown.id, authorizationNonce: countdown.authorizationNonce
      });
      if (canceled) await clearRecoveryAlarm(canceled.id);
      if (canceled) await safeSendAll(tabId, stopCountdownMessage(canceled, "Playback recovered", true));
    }
  }
  return { ok: true, primary: election.isOwner, lease: election.isOwner ? election.lease : null };
}

async function authorizeRecoveryAction(
  sender: chrome.runtime.MessageSender,
  message: Extract<RuntimeMessage, { type: "AUTHORIZE_RECOVERY_ACTION" }>
) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (tabId === undefined) return { authorized: false, error: "No tab context" };
  const navigationRevision = topNavigationRevisions.get(tabId) ?? 0;
  const status = runtimeTabs.get(tabId)?.frames.get(frameId);
  if (!status || Date.now() - status.updatedAt > 45_000) return { authorized: false, error: "The player report is stale" };
  if (!primaryLeases.owns(tabId, frameId, status.navigationId, status.candidateId, status.candidateEpoch)) {
    return { authorized: false, primary: false, error: "This frame is not the elected primary player" };
  }
  if (status.recoveryCycleId !== message.recoveryCycleId) return { authorized: false, error: "Recovery-cycle identity changed" };
  const revalidation = await revalidateRecovery(tabId, status, message.action, message.recoveryCycleId);
  if (!revalidation.ok) return { authorized: false, error: revalidation.error };
  const topLevelUrl = await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)
    .then((tab) => tab.url ?? "").catch(() => "");
  let topLevelUrlKey = "";
  if (message.action === "PAGE_RELOAD") {
    const topLevelCheck = await validateTopLevelReloadTarget(topLevelUrl);
    if (!topLevelCheck.ok) return { authorized: false, error: topLevelCheck.error };
    topLevelUrlKey = await navigationBindingKey(topLevelUrl) ?? "";
    if (!topLevelUrlKey) {
      return { authorized: false, error: "The top-level page could not be bound to this refresh authorization" };
    }
  }
  const ownerPageUrlKey = await navigationBindingKey(message.pageUrl);
  if (!ownerPageUrlKey) return { authorized: false, error: "The player page could not be bound to this recovery action" };
  const finalRevalidation = await revalidateRecovery(tabId, status, message.action, message.recoveryCycleId);
  if (!finalRevalidation.ok) return { authorized: false, error: finalRevalidation.error };
  if (message.action === "PAGE_RELOAD") {
    const finalTopLevel = await revalidateBoundTopLevelReload(tabId, {
      topLevelUrlKey
    });
    if (!finalTopLevel.ok) return { authorized: false, error: finalTopLevel.error };
  }
  // No await between this latch and queuing the coordinator transaction. A
  // simultaneous snooze either wins here or queues a cancellation after the
  // authorization; it cannot leave a hidden post-snooze countdown.
  const current = currentOwnedStatus(tabId, frameId);
  if (!current || current.navigationId !== status.navigationId || current.candidateId !== status.candidateId ||
    current.candidateEpoch !== status.candidateEpoch || current.recoveryCycleId !== message.recoveryCycleId) {
    return { authorized: false, error: "The elected player changed while recovery was being authorized" };
  }
  if (tabControlMutationActive(tabId) || topNavigationInProgress.has(tabId) ||
    (topNavigationRevisions.get(tabId) ?? 0) !== navigationRevision) {
    return { authorized: false, error: "Monitoring controls are changing" };
  }
  const authorizationPromise = recoveryCoordinator.authorize({
    tabId, frameId, navigationId: status.navigationId, candidateId: status.candidateId,
    candidateEpoch: status.candidateEpoch, cycleId: message.recoveryCycleId, origin: message.origin,
    pageUrl: message.pageUrl, action: message.action, failureKind: status.diagnosis.kind,
    countdownSeconds: finalRevalidation.settings.refreshCountdownSeconds,
    budget: budgetFor(finalRevalidation.settings, message.action),
    topLevelUrlKey, ownerPageUrlKey
  });
  const result = await authorizationPromise;
  if (!result.authorized) return result;
  const authorization = result.authorization as RecoveryActionAuthorization;
  if (message.action === "PAGE_RELOAD" && authorization.countdownDeadline !== null) {
    const countdownMessage: RuntimeMessage = {
      type: "START_COUNTDOWN", reason: message.reason,
      deadline: authorization.countdownDeadline, recoveryCycleId: authorization.cycleId,
      actionId: authorization.actionId, authorizationNonce: authorization.authorizationNonce
    };
    const countdownDelivery = await deliverCountdown(tabId, frameId, countdownMessage);
    if (!countdownDelivery) {
      const pending = await recoveryCoordinator.getAction(tabId, authorization.cycleId, authorization.actionId);
      if (!pending) return { authorized: false, error: "The refresh authorization was lost before its countdown could be displayed" };
      await cancelScheduledRecovery(tabId, pending, "A visible refresh countdown could not be displayed");
      return { authorized: false, error: "A visible refresh countdown could not be displayed" };
    }
    const acknowledgedDisplay = await recoveryCoordinator.acknowledgeCountdownDisplay(
      tabId, authorization.cycleId, authorization.actionId,
      authorization.authorizationNonce, countdownDelivery.frameId
    );
    if (!acknowledgedDisplay) {
      const pending = await recoveryCoordinator.getAction(tabId, authorization.cycleId, authorization.actionId);
      if (pending) await cancelScheduledRecovery(tabId, pending, "The visible countdown acknowledgement could not be persisted");
      return { authorized: false, error: "The visible countdown acknowledgement could not be persisted" };
    }
    getTabState(tabId).countdownSourceFrame = countdownDelivery.frameId;
    await scheduleRecoveryAlarm(tabId, authorization.actionId, authorization.countdownDeadline);
    await appendHistory({
      event: "countdown-started", detail: message.reason, level: "warning", url: message.pageUrl,
      tabId, frameId, metadata: { confidence: message.confidence, recoveryCycleId: message.recoveryCycleId, actionId: authorization.actionId }
    });
  } else {
    // If the content executor disappears between authorization and commit, a
    // durable alarm releases the pending cycle without recording a mutation.
    await scheduleRecoveryAlarm(tabId, authorization.actionId, authorization.expiresAt);
  }
  return { authorized: true, primary: true, authorization };
}

async function deliverCountdown(
  tabId: number, ownerFrameId: number, message: RuntimeMessage
): Promise<{ frameId: number } | null> {
  void ownerFrameId;
  // Only the top frame can prove that the cancel control is visible and
  // interactive in the top-level viewport. A child-local rectangle cannot
  // prove that its cross-origin iframe is not clipped or hidden by its parent.
  try {
    const response = await sendTabMessage<{ ok?: boolean; visible?: boolean }>(tabId, message, { frameId: 0 });
    if (response?.ok === true && response.visible === true) return { frameId: 0 };
  } catch { /* fail closed when no top-frame safety UI is available */ }
  return null;
}

async function commitRecoveryAction(
  sender: chrome.runtime.MessageSender,
  message: Extract<RuntimeMessage, { type: "COMMIT_RECOVERY_ACTION" }>
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { allowed: false, error: "No tab context" };
  const action = await recoveryCoordinator.getAction(tabId, message.recoveryCycleId, message.actionId);
  if (!action || action.authorizationNonce !== message.authorizationNonce) {
    return { allowed: false, error: "Unknown recovery authorization" };
  }
  const senderFrameId = sender.frameId ?? 0;
  if (action.action === "PAGE_RELOAD") {
    if (action.displayFrameId === null || senderFrameId !== action.displayFrameId) {
      return { allowed: false, error: "Only the frame displaying the countdown can commit the scheduled reload" };
    }
  } else if (senderFrameId !== action.ownerFrameId) {
    return { allowed: false, error: "The recovery executor no longer owns this action" };
  }
  return commitRecoveryAuthorization(tabId, message.recoveryCycleId, message.actionId, message.authorizationNonce);
}

async function commitRecoveryAuthorization(
  tabId: number, cycleId: string, actionId: string, authorizationNonce: string
) {
  const navigationRevision = topNavigationRevisions.get(tabId) ?? 0;
  const action = await recoveryCoordinator.getAction(tabId, cycleId, actionId);
  if (!action || action.authorizationNonce !== authorizationNonce) return { allowed: false, error: "Unknown recovery authorization" };
  if (action.action === "PAGE_RELOAD") {
    const topLevel = await revalidateBoundTopLevelReload(tabId, action);
    if (!topLevel.ok) return cancelScheduledRecovery(tabId, action, topLevel.error);
  }
  const status = await recoveryOwnerStatus(tabId, action);
  if (!status) return cancelScheduledRecovery(tabId, action, "The elected player report is stale");
  const revalidation = await revalidateRecovery(tabId, status, action.action, cycleId, action);
  if (!revalidation.ok) return cancelScheduledRecovery(tabId, action, revalidation.error);
  const committed = await recoveryCoordinator.commit(tabId, cycleId, actionId, authorizationNonce, budgetFor(revalidation.settings, action.action));
  if (!committed.allowed || !committed.action) {
    if (committed.duplicate) return { allowed: false, duplicate: true, error: committed.error };
    const canceled = await cancelScheduledRecovery(tabId, action, committed.error ?? "Recovery authorization was denied");
    return { allowed: false, canceled: canceled.canceled, error: committed.error ?? canceled.error };
  }

  await clearRecoveryAlarm(actionId);
  // Re-arm the same identity at the execution/verification deadline. This
  // reconciles a committed nonce after a page reload or if a DOM executor
  // vanishes before reporting a terminal result.
  await scheduleRecoveryAlarm(tabId, actionId, committed.action.expiresAt);
  if (action.action === "IFRAME_RELOAD") {
    try {
      const result = await sendTabMessage<{ ok?: boolean; recovered?: boolean }>(tabId, { type: "RECOVER_IFRAME", frameToken: status.frameToken } satisfies RuntimeMessage, { frameId: 0 });
      if (!result?.recovered) {
        await completeInternalRecovery(tabId, status.origin, action, false, 0, "The bound player frame was no longer available");
        return { allowed: false, error: "The bound player frame was no longer available" };
      }
      return { allowed: true, executedByBackground: true };
    } catch {
      await completeInternalRecovery(tabId, status.origin, action, false, 0, "The top frame could not reload the embedded player");
      return { allowed: false, error: "The top frame could not reload the embedded player" };
    }
  }
  if (action.action === "PAGE_RELOAD") {
    const loopAllowed = await recordCommittedPageReload(tabId, status.origin, status.pageUrl);
    if (!loopAllowed.allowed) {
      await completeInternalRecovery(tabId, status.origin, action, false, 0, "Page-reload loop limit reached");
      return { allowed: false, error: "Page-reload loop limit reached" };
    }
    getTabState(tabId).countdownSourceFrame = undefined;
    try {
      await appendHistory({
        event: "page-reload", detail: `Automatic page reload ${loopAllowed.attempts}/${revalidation.settings.maxAutoRefreshes}`,
        level: "warning", url: status.pageUrl, tabId, frameId: action.ownerFrameId,
        metadata: { recoveryCycleId: cycleId, actionId }
      });
      const finalTopLevel = await revalidateBoundTopLevelReload(tabId, committed.action);
      if (!finalTopLevel.ok) {
        await completeInternalRecovery(tabId, status.origin, committed.action, false, 0, finalTopLevel.error);
        return { allowed: false, error: finalTopLevel.error };
      }
      // tabs.onUpdated increments this latch synchronously. No await may occur
      // between the final comparison and invoking the browser mutation.
      if (topNavigationInProgress.has(tabId) || (topNavigationRevisions.get(tabId) ?? 0) !== navigationRevision) {
        const error = "The page navigation changed while the scheduled reload was being verified";
        await completeInternalRecovery(tabId, status.origin, committed.action, false, 0, error);
        return { allowed: false, error };
      }
      const initiated = apiCall<void>(ext.tabs.reload, ext.tabs, tabId);
      runtimeTabs.delete(tabId);
      primaryLeases.removeTab(tabId);
      await initiated;
      return { allowed: true, executedByBackground: true, reloadInitiated: true };
    } catch {
      await completeInternalRecovery(tabId, status.origin, action, false, 0, "The browser rejected the tab reload");
      return { allowed: false, error: "The browser rejected the tab reload" };
    }
  }
  return { allowed: true, executedByBackground: false };
}

async function completeRecoveryAction(
  sender: chrome.runtime.MessageSender,
  message: Extract<RuntimeMessage, { type: "COMPLETE_RECOVERY_ACTION" }>
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { recorded: false, error: "No tab context" };
  const frameId = sender.frameId ?? 0;
  const action = await recoveryCoordinator.getAction(tabId, message.recoveryCycleId, message.actionId);
  if (!action || action.authorizationNonce !== message.authorizationNonce) {
    return { recorded: false, error: "Unknown recovery authorization" };
  }
  if (action.ownerFrameId !== frameId) {
    return { recorded: false, error: "The recovery result came from a different frame" };
  }
  const status = currentOwnedStatus(tabId, frameId);
  if (!status) return { recorded: false, error: "The elected player report is missing or stale" };
  if (status.origin !== message.origin || urlKey(status.pageUrl) !== urlKey(message.pageUrl)) {
    return { recorded: false, error: "The recovery result does not match the current player page" };
  }
  const cycle = await recoveryCoordinator.getCycle(tabId, message.recoveryCycleId);
  if (!cycle || cycle.origin !== status.origin || cycle.ownerFrameId !== frameId ||
    cycle.currentUrlKey !== urlKey(status.pageUrl) || !cycle.navigationIds.includes(status.navigationId)) {
    return { recorded: false, error: "The recovery cycle no longer belongs to this player" };
  }
  if (status.recoveryCycleId !== cycle.id) {
    return { recorded: false, error: "The player is no longer reporting this recovery cycle" };
  }
  if (action.action !== "PAGE_RELOAD" && (status.navigationId !== action.navigationId ||
    status.candidateId !== action.candidateId || status.candidateEpoch !== action.candidateEpoch)) {
    return { recorded: false, error: "The player identity changed before the result was verified" };
  }
  if (message.failureKind !== action.failureKind) {
    return { recorded: false, error: "The recovery diagnosis changed before completion" };
  }
  const result = await recoveryCoordinator.complete(
    tabId, message.recoveryCycleId, message.actionId, message.authorizationNonce,
    message.success, message.durationMs, message.reason ?? null
  );
  if (!result.recorded || !result.action) return result;
  await clearRecoveryAlarm(result.action.id);
  await recordActionOutcome(cycle.origin, {
    action: result.action.action, failureKind: result.action.failureKind, success: message.success,
    durationMs: message.durationMs, timestamp: Date.now()
  });
  await appendHistory({
    event: message.success ? "recovery-action-succeeded" : "recovery-action-failed",
    detail: `${result.action.action} ${message.success ? "restored playback" : "did not restore playback"}`,
    level: message.success ? "success" : "warning", url: status.pageUrl, tabId, frameId,
    metadata: {
      action: result.action.action, recoveryCycleId: message.recoveryCycleId,
      actionId: message.actionId, failureKind: result.action.failureKind
    }
  });
  return result;
}

async function completeInternalRecovery(
  tabId: number, origin: string, action: RecoveryActionRecord, success: boolean, durationMs: number, reason: string
) {
  const result = await recoveryCoordinator.complete(
    tabId, action.cycleId, action.id, action.authorizationNonce, success, durationMs, reason
  );
  if (result.recorded) {
    await clearRecoveryAlarm(action.id);
    await recordActionOutcome(origin, {
      action: action.action, failureKind: action.failureKind, success, durationMs, timestamp: Date.now()
    });
  }
  return result;
}

async function extendAutoRefresh(
  sender: chrome.runtime.MessageSender,
  message: Extract<RuntimeMessage, { type: "EXTEND_AUTO_REFRESH" }>
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false, error: "No tab context" };
  const current = await recoveryCoordinator.getAction(tabId, message.recoveryCycleId, message.actionId);
  if (!current || current.authorizationNonce !== message.authorizationNonce || current.state !== "COUNTDOWN") {
    return { ok: false, error: "The countdown is no longer active" };
  }
  const senderFrameId = sender.frameId ?? 0;
  if (current.displayFrameId !== senderFrameId) {
    return { ok: false, error: "Only the frame displaying the countdown can extend it" };
  }
  const extended = await recoveryCoordinator.extendCountdown(tabId, message.seconds, {
    cycleId: message.recoveryCycleId, actionId: message.actionId, authorizationNonce: message.authorizationNonce
  });
  if (!extended?.countdownDeadline) return { ok: false, error: "The countdown is no longer active" };
  await scheduleRecoveryAlarm(tabId, extended.id, extended.countdownDeadline);
  if (extended.ownerFrameId !== senderFrameId) {
    try {
      const ownerResponse = await sendTabMessage<{ ok?: boolean }>(
        tabId, syncCountdownMessage(extended), { frameId: extended.ownerFrameId }
      );
      if (ownerResponse?.ok !== true) throw new Error("Owner did not acknowledge the deadline");
    } catch {
      await cancelExtendedCountdownOrObserveMove(
        tabId, extended, "The recovery owner could not confirm the extended deadline"
      );
      return { ok: false, error: "The recovery owner could not confirm the extended deadline" };
    }
  }
  return { ok: true, deadline: extended.countdownDeadline };
}

async function executeScheduledRecovery(tabId: number, actionId: string): Promise<void> {
  const countdown = await recoveryCoordinator.getCountdown(tabId);
  if (countdown?.id === actionId && countdown.countdownDeadline !== null) {
    if (Date.now() < countdown.countdownDeadline) {
      await scheduleRecoveryAlarm(tabId, actionId, countdown.countdownDeadline);
      return;
    }
    // The continuously painted top-frame panel is the sole executor. This
    // alarm is only a fail-closed watchdog and never asks a delayed renderer
    // to mutate the page after its controls may have been unresponsive.
    if (Date.now() < countdown.countdownDeadline + COUNTDOWN_COMMIT_GRACE_MS) {
      await scheduleRecoveryAlarm(tabId, actionId, countdown.countdownDeadline + COUNTDOWN_COMMIT_GRACE_MS);
      return;
    }
    const canceled = await cancelScheduledRecovery(
      tabId, countdown, "The visible countdown did not commit from a continuously responsive top-frame panel",
      countdown.countdownDeadline
    );
    if (!canceled.canceled) {
      const moved = await recoveryCoordinator.getCountdown(tabId);
      if (moved?.id === actionId && moved.countdownDeadline !== null) {
        await scheduleRecoveryAlarm(tabId, actionId, moved.countdownDeadline);
      }
    }
  } else {
    await reconcileExpiredRecoveries(tabId, actionId);
  }
}

async function revalidateRecovery(
  tabId: number, status: FrameStatus, action: RecoveryAction, cycleId: string, authorization?: RecoveryActionRecord
): Promise<{ ok: true; settings: EffectiveSettings } | { ok: false; error: string }> {
  if (tabControlMutationActive(tabId)) {
    return { ok: false, error: "Monitoring controls are changing" };
  }
  const [settings, acknowledged, loops] = await Promise.all([loadSettings(), getDisclaimerAcknowledged(), getLoopStore()]);
  if (tabControlMutationActive(tabId)) {
    return { ok: false, error: "Monitoring controls are changing" };
  }
  const effective = effectiveSettings(settings, status.origin);
  if (!acknowledged) return { ok: false, error: "The disclaimer acknowledgement is no longer active" };
  if (!effective.enabled || !effective.siteEnabled) return { ok: false, error: "Automatic recovery is disabled" };
  const automaticSetting = validateAutomaticRecoverySetting(action, effective);
  if (!automaticSetting.allowed) return { ok: false, error: automaticSetting.reason };
  const pattern = originPattern(status.origin);
  if (!pattern || !await hasOriginPermission(pattern)) return { ok: false, error: "Site access permission is no longer granted" };
  const snoozedUntil = loops[String(tabId)]?.snoozedUntil;
  if (snoozedUntil === -1 || (snoozedUntil && snoozedUntil > Date.now())) return { ok: false, error: "Monitoring is snoozed" };
  if (Date.now() - status.updatedAt > 45_000) return { ok: false, error: "The elected player report is stale" };
  if (authorization && (status.navigationId !== authorization.navigationId || status.candidateId !== authorization.candidateId || status.candidateEpoch !== authorization.candidateEpoch)) {
    return { ok: false, error: "The elected player changed during recovery" };
  }
  if (status.recoveryCycleId !== cycleId) return { ok: false, error: "Recovery-cycle identity changed" };
  if (!status.hasVideo) return { ok: false, error: "The elected player is no longer available" };
  if (!status.online) return { ok: false, error: "The browser is offline" };
  if (effective.onlyWhenTabVisible && !status.pageVisible) return { ok: false, error: "The monitored tab is hidden" };
  if (["USER_PAUSED", "ACCESS_INTERRUPTION", "TAB_SUSPENDED", "BROWSER_RESUMED"].includes(status.diagnosis.kind)) {
    return { ok: false, error: "Playback state is no longer safe for automatic recovery" };
  }
  if (["HEALTHY", "DISABLED", "SITE_NOT_ENABLED", "URL_EXCLUDED", "SNOOZED", "OFFLINE", "NO_VIDEO_FOUND"].includes(status.state)) {
    return { ok: false, error: "Playback no longer requires automatic recovery" };
  }
  if (action !== "WAIT" && action !== "USER_PROMPT" && !status.diagnosis.recoverySafe) {
    return { ok: false, error: "The current diagnosis does not permit an automatic mutation" };
  }
  return { ok: true, settings: effective };
}

async function validateTopLevelReloadTarget(
  topLevelUrl: string
): Promise<{ ok: true; origin: string; settings: EffectiveSettings } | { ok: false; error: string }> {
  const origin = getOrigin(topLevelUrl);
  if (!origin) return { ok: false, error: "The top-level page is not a supported monitoring target" };
  const [settings, acknowledged] = await Promise.all([loadSettings(), getDisclaimerAcknowledged()]);
  if (!acknowledged) return { ok: false, error: "The disclaimer acknowledgement is no longer active" };
  const effective = effectiveSettings(settings, origin);
  if (!effective.enabled || !effective.siteEnabled) {
    return { ok: false, error: "The top-level site is not enabled for automatic page reloads" };
  }
  if (!isUrlEnabled(topLevelUrl, effective)) {
    return { ok: false, error: "The top-level URL is excluded from monitoring" };
  }
  const automatic = validateAutomaticRecoverySetting("PAGE_RELOAD", effective);
  if (!automatic.allowed) return { ok: false, error: `Top-level page reload denied: ${automatic.reason}` };
  const pattern = originPattern(origin);
  if (!pattern || !await hasOriginPermission(pattern)) {
    return { ok: false, error: "The top-level site has not granted exact-origin access" };
  }
  return { ok: true, origin, settings: effective };
}

async function revalidateBoundTopLevelReload(
  tabId: number, action: Pick<RecoveryActionRecord, "topLevelUrlKey">
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const initialTab = await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId).catch(() => null);
  const topLevelUrl = initialTab?.url ?? "";
  if (!initialTab || initialTab.status === "loading" || topNavigationInProgress.has(tabId)) {
    return { ok: false, error: "The top-level page is navigating" };
  }
  const key = await navigationBindingKey(topLevelUrl);
  if (!action.topLevelUrlKey || !key || key !== action.topLevelUrlKey) {
    return { ok: false, error: "The tab navigated away before the scheduled reload" };
  }
  const target = await validateTopLevelReloadTarget(topLevelUrl);
  if (!target.ok) return target;
  // Read the tab URL/status last so settings and permission awaits cannot
  // leave a stale target authorized at the final mutation boundary.
  const finalTab = await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId).catch(() => null);
  const finalUrl = finalTab?.url ?? "";
  const finalKey = await navigationBindingKey(finalUrl);
  if (!finalTab || finalTab.status === "loading" || topNavigationInProgress.has(tabId) ||
    !finalKey || finalKey !== action.topLevelUrlKey) {
    return { ok: false, error: "The tab navigated away before the scheduled reload" };
  }
  return { ok: true, url: finalUrl };
}

async function recoveryOwnerStatus(tabId: number, action: RecoveryActionRecord): Promise<FrameStatus | null> {
  const runtime = runtimeTabs.get(tabId)?.frames.get(action.ownerFrameId);
  if (runtime && runtime.navigationId === action.navigationId && runtime.candidateId === action.candidateId &&
    runtime.candidateEpoch === action.candidateEpoch) {
    const lease = primaryLeases.get(tabId);
    if (lease && (lease.frameId !== action.ownerFrameId || lease.navigationId !== action.navigationId ||
      lease.candidateId !== action.candidateId || lease.candidateEpoch !== action.candidateEpoch)) return null;
    return runtime;
  }
  // MV3 service workers may be restarted between scheduling and the alarm. A
  // fresh persisted owner report, bound to the original authorization, is the
  // only safe fallback; an absent or mismatched report cancels the action.
  const persisted = (await getStatusStore())[String(tabId)];
  return persisted && persisted.navigationId === action.navigationId && persisted.candidateId === action.candidateId &&
    persisted.candidateEpoch === action.candidateEpoch && Date.now() - persisted.updatedAt <= 45_000 ? persisted : null;
}

function currentOwnedStatus(tabId: number, frameId: number): FrameStatus | null {
  const status = runtimeTabs.get(tabId)?.frames.get(frameId);
  if (!status || Date.now() - status.updatedAt > 45_000) return null;
  return primaryLeases.owns(
    tabId, frameId, status.navigationId, status.candidateId, status.candidateEpoch
  ) ? status : null;
}

function budgetFor(settings: EffectiveSettings, action: RecoveryAction): ActionBudget {
  return {
    windowMs: settings.refreshWindowMinutes * 60_000,
    perActionLimit: actionLimit(action, settings.maxAutoRefreshes, settings.maxRecoveryActionsPerCycle),
    maxCycleActions: settings.maxRecoveryActionsPerCycle,
    executionTimeoutMs: Math.max(30_000,
      (settings.recoveryVerificationSeconds + settings.suspectCheckIntervalSeconds * 2 + 15) * 1000)
  };
}

async function cancelScheduledRecovery(
  tabId: number, action: RecoveryActionRecord, reason: string, expectedCountdownDeadline?: number
) {
  const canceled = await recoveryCoordinator.cancelCurrent(tabId, reason, {
    cycleId: action.cycleId, actionId: action.id, authorizationNonce: action.authorizationNonce,
    countdownDeadline: expectedCountdownDeadline
  });
  if (!canceled) {
    return { allowed: false, canceled: false, error: `${reason}; the recovery action is no longer cancellable` };
  }
  await finalizeCanceledRecovery(tabId, canceled, reason);
  return { allowed: false, canceled: true, error: reason };
}

async function finalizeCanceledRecovery(tabId: number, action: RecoveryActionRecord, reason: string): Promise<void> {
  await clearRecoveryAlarm(action.id);
  getTabState(tabId).countdownSourceFrame = undefined;
  await safeSendAll(tabId, stopCountdownMessage(action, reason, true));
  await appendHistory({
    event: "recovery-action-canceled", detail: reason, level: "info", url: "", tabId,
    metadata: { recoveryCycleId: action.cycleId, actionId: action.id, action: action.action }
  });
}

async function cancelExtendedCountdownOrObserveMove(
  tabId: number, action: RecoveryActionRecord, reason: string
): Promise<boolean> {
  if (action.countdownDeadline === null) return false;
  const result = await cancelScheduledRecovery(tabId, action, reason, action.countdownDeadline);
  if (result.canceled) return true;
  const moved = await recoveryCoordinator.getCountdown(tabId);
  if (moved?.id === action.id && moved.countdownDeadline !== null) {
    await scheduleRecoveryAlarm(tabId, moved.id, moved.countdownDeadline);
  }
  return false;
}

function syncCountdownMessage(
  action: RecoveryActionRecord
): Extract<RuntimeMessage, { type: "EXTEND_COUNTDOWN_IN_PAGE" }> {
  return {
    type: "EXTEND_COUNTDOWN_IN_PAGE", deadline: action.countdownDeadline ?? Date.now(),
    recoveryCycleId: action.cycleId, actionId: action.id, authorizationNonce: action.authorizationNonce
  };
}

function stopCountdownMessage(
  action: RecoveryActionRecord, reason: string, cancelRecovery: boolean
): Extract<RuntimeMessage, { type: "STOP_COUNTDOWN" }> {
  return {
    type: "STOP_COUNTDOWN", recoveryCycleId: action.cycleId, actionId: action.id,
    authorizationNonce: action.authorizationNonce, reason, cancelRecovery
  };
}

async function cancelPendingRecoveryAfterTopLevelNavigation(tabId: number, reason: string): Promise<void> {
  const canceled = await recoveryCoordinator.cancelCurrent(tabId, reason);
  if (canceled) await finalizeCanceledRecovery(tabId, canceled, reason);
}

async function reconcileLostRecoveryExecutors(tabId: number, owner: RecoveryOwnerMatch, reason: string): Promise<void> {
  const expired = await recoveryCoordinator.expireCommittedForOwner(tabId, owner, reason);
  await recordExpiredRecoveryActions(expired);
}

async function reconcileExpiredRecoveries(tabId?: number, actionId?: string): Promise<void> {
  const expired = await recoveryCoordinator.reconcileExpired(tabId, actionId);
  await recordExpiredRecoveryActions(expired);
  // Browser clocks and alarm implementations can occasionally deliver a
  // little early. Never drop the only durable deadline in that case.
  if (tabId !== undefined && actionId && !expired.length) {
    const pending = (await recoveryCoordinator.getPendingActions())
      .find((item) => item.tabId === tabId && item.action.id === actionId);
    if (pending) {
      const deadline = pending.action.state === "COUNTDOWN" && pending.action.countdownDeadline !== null
        ? pending.action.countdownDeadline : pending.action.expiresAt;
      if (deadline > Date.now()) await scheduleRecoveryAlarm(tabId, actionId, deadline);
    }
  }
}

async function recordExpiredRecoveryActions(expired: ExpiredRecoveryAction[]): Promise<void> {
  for (const result of expired) {
    const action = result.action;
    await clearRecoveryAlarm(action.id);
    await recordActionOutcome(result.origin, {
      action: action.action, failureKind: action.failureKind, success: false,
      durationMs: action.durationMs ?? 0, timestamp: action.terminalAt ?? Date.now()
    });
    await appendHistory({
      event: "recovery-action-expired", detail: action.terminalReason ?? "The recovery executor disappeared",
      level: "warning", url: "", tabId: result.tabId, frameId: action.ownerFrameId,
      metadata: {
        recoveryCycleId: action.cycleId, actionId: action.id, action: action.action,
        failureKind: action.failureKind
      }
    });
  }
}

async function recordCommittedPageReload(tabId: number, origin: string, pageUrl: string): Promise<{ allowed: boolean; attempts: number }> {
  const settings = effectiveSettings(await loadSettings(), origin);
  return withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = normalizedLoopEntry(store[String(tabId)], pageUrl);
    const now = Date.now();
    const windowMs = settings.refreshWindowMinutes * 60_000;
    entry.attempts = entry.attempts.filter((time) => now - time < windowMs);
    if (entry.attempts.length >= settings.maxAutoRefreshes) return { allowed: false, attempts: entry.attempts.length };
    entry.attempts.push(now);
    entry.actionAttempts.PAGE_RELOAD = [...(entry.actionAttempts.PAGE_RELOAD ?? []).filter((time) => now - time < windowMs), now];
    entry.pendingMaximizeAt = settings.autoMaximize ? now : null;
    store[String(tabId)] = entry;
    await setLoopStore(store);
    return { allowed: true, attempts: entry.attempts.length };
  });
}

async function requestAutoRefresh(sender: chrome.runtime.MessageSender, origin: string, pageUrl: string, reason: string, confidence: number) {
  void sender; void origin; void pageUrl; void reason; void confidence;
  // Kept only so an older content bundle fails closed during a staged update.
  // Automatic recovery now requires elected-player identity, a correlated
  // cycle, and a one-use action authorization.
  return { ok: false, error: "The monitor must re-report its elected player before automatic recovery" };
}

async function recordAutoRefresh(sender: chrome.runtime.MessageSender, origin: string, pageUrl: string) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { allowed: false };
  const settings = effectiveSettings(await loadSettings(), origin);
  const automaticSetting = validateAutomaticRecoverySetting("PAGE_RELOAD", settings);
  if (!settings.enabled || !settings.siteEnabled || !automaticSetting.allowed) {
    return { allowed: false, error: automaticSetting.allowed ? "Automatic recovery is disabled" : automaticSetting.reason };
  }
  return withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = normalizedLoopEntry(store[String(tabId)], pageUrl);
    const now = Date.now();
    const windowMs = settings.refreshWindowMinutes * 60_000;
    entry.attempts = entry.attempts.filter((time) => now - time < windowMs);
    if (entry.attempts.length >= settings.maxAutoRefreshes) return { allowed: false };
    entry.attempts.push(now);
    entry.actionAttempts.PAGE_RELOAD = [...(entry.actionAttempts.PAGE_RELOAD ?? []), now];
    entry.pendingMaximizeAt = settings.autoMaximize ? now : null;
    store[String(tabId)] = entry;
    await setLoopStore(store);
    getTabState(tabId).countdownSourceFrame = undefined;
    await appendHistory({ event: "page-reload", detail: `Automatic page reload ${entry.attempts.length}/${settings.maxAutoRefreshes}`, level: "warning", url: pageUrl, tabId });
    return { allowed: true };
  });
}

async function inspectAllowance(tabId: number, pageUrl: string, settings: EffectiveSettings) {
  return withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = normalizedLoopEntry(store[String(tabId)], pageUrl);
    const now = Date.now();
    const windowMs = settings.refreshWindowMinutes * 60_000;
    entry.attempts = entry.attempts.filter((time) => now - time < windowMs);
    if (entry.attempts.length >= settings.maxAutoRefreshes) {
      entry.pausedUntil = entry.attempts[0] + windowMs;
      store[String(tabId)] = entry;
      await setLoopStore(store);
      return { allowed: false, pausedUntil: entry.pausedUntil };
    }
    return { allowed: true, attempts: entry.attempts.length };
  });
}

async function recoverIframe(sender: chrome.runtime.MessageSender, frameToken: string) {
  void sender;
  void frameToken;
  // A legacy content bundle must not bypass the tab-wide primary lease and
  // one-use recovery nonce. The current bundle uses AUTHORIZE/COMMIT and gets
  // an explicit routed-delivery acknowledgement from the top frame.
  return { ok: false, error: "The monitor must re-authorize the embedded-player recovery action" };
}

async function cancelAutoRefresh(
  tabId?: number,
  expected?: Pick<Extract<RuntimeMessage, { type: "CANCEL_AUTO_REFRESH" }>, "recoveryCycleId" | "actionId" | "authorizationNonce">,
  requesterFrameId?: number
) {
  if (tabId === undefined) return { ok: true };
  if (requesterFrameId !== undefined) {
    if (!expected?.recoveryCycleId || !expected.actionId || !expected.authorizationNonce) {
      return { ok: false, canceled: false, error: "Only the frame displaying this countdown can cancel it" };
    }
    const current = await recoveryCoordinator.getAction(tabId, expected.recoveryCycleId, expected.actionId);
    if (!current || current.authorizationNonce !== expected.authorizationNonce || current.state !== "COUNTDOWN" ||
      current.displayFrameId !== requesterFrameId) {
      return { ok: false, canceled: false, error: "The countdown is no longer active" };
    }
  }
  getTabState(tabId).countdownSourceFrame = undefined;
  const canceled = await recoveryCoordinator.cancelCurrent(tabId, "User canceled the scheduled page reload", expected);
  if (canceled) await clearRecoveryAlarm(canceled.id);
  if (canceled) await safeSendAll(tabId, stopCountdownMessage(canceled, "Scheduled reload canceled", true));
  return { ok: true, canceled: !!canceled };
}
async function clearAfterSuccess(sender: chrome.runtime.MessageSender, pageUrl: string, recoveryCycleId?: string) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false, error: "No tab context" };
  const frameId = sender.frameId ?? 0;
  const status = currentOwnedStatus(tabId, frameId);
  if (!status || status.state !== "HEALTHY" || urlKey(status.pageUrl) !== urlKey(pageUrl)) {
    return { ok: false, error: "Only the current healthy primary player can reset recovery budgets" };
  }
  let cycleUrlKeys: string[] = [];
  if (recoveryCycleId) {
    const cycle = await recoveryCoordinator.getCycle(tabId, recoveryCycleId);
    if (!cycle || cycle.state !== "SUCCEEDED" || cycle.origin !== status.origin ||
      cycle.ownerFrameId !== frameId || cycle.currentUrlKey !== urlKey(pageUrl) ||
      !cycle.navigationIds.includes(status.navigationId)) {
      return { ok: false, error: "The completed recovery cycle no longer belongs to this player" };
    }
    cycleUrlKeys = cycle.urlChain;
  }
  await recoveryCoordinator.clearBudgets(tabId);
  await withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = store[String(tabId)];
    if (entry && (entry.urlKey === urlKey(pageUrl) || cycleUrlKeys.includes(entry.urlKey))) {
      entry.urlKey = urlKey(pageUrl);
      entry.attempts = [];
      entry.actionAttempts = {};
      entry.pausedUntil = null;
      await setLoopStore(store);
    }
  });
  return { ok: true };
}

async function extendTabCountdown(tabId: number, seconds: number) {
  const current = await recoveryCoordinator.getCountdown(tabId);
  const sourceFrameId = current?.displayFrameId ?? undefined;
  if (sourceFrameId === undefined) return { ok: false, error: "The visible countdown route is unavailable" };
  const extended = await recoveryCoordinator.extendCountdown(tabId, seconds, {
    cycleId: current!.cycleId, actionId: current!.id, authorizationNonce: current!.authorizationNonce
  });
  if (!extended?.countdownDeadline) return { ok: false, error: "No active countdown" };
  await scheduleRecoveryAlarm(tabId, extended.id, extended.countdownDeadline);
  let visible = false;
  try {
    const response = await sendTabMessage<{ ok?: boolean; visible?: boolean }>(
      tabId, syncCountdownMessage(extended), { frameId: sourceFrameId }
    );
    visible = response?.ok === true && response.visible === true;
  } catch { /* cancellation below prevents a hidden later reload */ }
  if (!visible) {
    await cancelExtendedCountdownOrObserveMove(
      tabId, extended, "The visible countdown could not confirm its extension"
    );
    return { ok: false, error: "The visible countdown could not confirm its extension" };
  }
  if (extended.ownerFrameId !== sourceFrameId) {
    try {
      const ownerResponse = await sendTabMessage<{ ok?: boolean }>(
        tabId, syncCountdownMessage(extended), { frameId: extended.ownerFrameId }
      );
      if (ownerResponse?.ok !== true) throw new Error("Owner did not acknowledge the deadline");
    } catch {
      await cancelExtendedCountdownOrObserveMove(
        tabId, extended, "The recovery owner could not confirm the extended deadline"
      );
      return { ok: false, error: "The recovery owner could not confirm the extended deadline" };
    }
  }
  return { ok: true, deadline: extended.countdownDeadline };
}
async function claimAutoMaximize(sender: chrome.runtime.MessageSender, pageUrl: string, recoveryCycleId: string) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { claimed: false };
  const frameId = sender.frameId ?? 0;
  const status = currentOwnedStatus(tabId, frameId);
  if (!status || urlKey(status.pageUrl) !== urlKey(pageUrl)) {
    return { claimed: false };
  }
  const currentSettings = effectiveSettings(await loadSettings(), status.origin);
  if (!currentSettings.enabled || !currentSettings.siteEnabled || !currentSettings.autoMaximize) {
    await withLoopLock(async () => {
      const store = await getLoopStore();
      const entry = store[String(tabId)];
      if (entry?.pendingMaximizeAt) {
        entry.pendingMaximizeAt = null;
        await setLoopStore(store);
      }
    });
    return { claimed: false };
  }
  const cycle = await recoveryCoordinator.getCycle(tabId, recoveryCycleId);
  const active = cycle?.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
  const terminalPageReload = cycle ? Object.values(cycle.actions).find((action) =>
    action.action === "PAGE_RELOAD" && ["SUCCEEDED", "FAILED"].includes(action.state) &&
    action.committedAt !== null && action.ownerFrameId === frameId) : undefined;
  const activeResume = cycle?.state === "ACTIVE" && status.recoveryCycleId === recoveryCycleId &&
    active?.action === "PAGE_RELOAD" && active.state === "INITIATED" && active.ownerFrameId === frameId;
  // Maximizing is a post-navigation presentation action, not evidence that the
  // recovery succeeded. A stream that remains broken may fail the old cycle
  // before the player-discovery dwell elapses, but only a cycle that adopted a
  // genuinely new document may consume this pending maximize request.
  const completedResume = !!cycle && ["SUCCEEDED", "FAILED"].includes(cycle.state) &&
    !!terminalPageReload && status.navigationId !== terminalPageReload.navigationId;
  if (!cycle || cycle.origin !== status.origin || cycle.ownerFrameId !== frameId ||
    cycle.currentUrlKey !== urlKey(pageUrl) || !cycle.navigationIds.includes(status.navigationId) ||
    (!activeResume && !completedResume)) {
    return { claimed: false };
  }
  return withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = store[String(tabId)];
    const claimed = !!entry?.pendingMaximizeAt && Date.now() - entry.pendingMaximizeAt < MAX_PENDING_AGE;
    if (claimed && entry) {
      entry.urlKey = cycle.currentUrlKey;
      entry.pendingMaximizeAt = null;
      await setLoopStore(store);
    }
    return { claimed };
  });
}

async function manualRefresh(tabId: number, origin: string) {
  void origin;
  // A browser user gesture cannot be carried across a navigation. Manual
  // refresh therefore reloads only; the popup's explicit Maximize command is
  // the safe post-navigation fallback.
  await apiCall<void>(ext.tabs.reload, ext.tabs, tabId);
  return { ok: true };
}
async function manualMaximize(tabId: number) { await safeSend(tabId, { type: "MAXIMIZE_NOW", manual: true }, selectBestFrame(tabId)); return { ok: true }; }
async function manualPictureInPicture(tabId: number) { await safeSend(tabId, { type: "PICTURE_IN_PICTURE_NOW" }, selectBestFrame(tabId)); return { ok: true }; }
async function manualJumpToLive(tabId: number) { await safeSend(tabId, { type: "JUMP_TO_LIVE_NOW" }, selectBestFrame(tabId)); return { ok: true }; }
async function startPickerInTab(tabId: number, field: SelectorField) { await safeSendAll(tabId, { type: "BEGIN_ELEMENT_PICKER", field }); return { ok: true }; }
async function startSelectorPicker(origin: string, field: SelectorField) {
  const tabs = await apiCall<chrome.tabs.Tab[]>(ext.tabs.query, ext.tabs, {});
  const tab = tabs.find((candidate) => getOrigin(candidate.url) === origin && candidate.id !== undefined);
  if (!tab?.id) return { ok: false, error: "Open the configured site in a tab before starting the picker." };
  await startPickerInTab(tab.id, field);
  return { ok: true, tabId: tab.id };
}

async function validateSiteSelector(origin: string, field: SelectorField, selector: string): Promise<SelectorValidationResult> {
  if (!selector.trim()) return {
    ok: true, syntacticallyValid: true, matchCount: 0, visibleCount: 0, riskyCount: 0,
    frameUrl: "", warning: "Empty selector: this custom rule is disabled."
  };
  const tabs = await apiCall<chrome.tabs.Tab[]>(ext.tabs.query, ext.tabs, {});
  const tab = tabs.find((candidate) => getOrigin(candidate.url) === origin && candidate.id !== undefined);
  if (tab?.id === undefined) return {
    ok: false, syntacticallyValid: true, matchCount: 0, visibleCount: 0, riskyCount: 0,
    frameUrl: "", warning: "", error: "Open the configured site in a tab to preview this selector."
  };
  const knownFrames = [...(runtimeTabs.get(tab.id)?.frames.keys() ?? [])];
  const frameIds = [...new Set([selectBestFrame(tab.id), 0, ...knownFrames])];
  let best: SelectorValidationResult | null = null;
  for (const frameId of frameIds) {
    try {
      const result = await sendTabMessage<SelectorValidationResult>(tab.id, { type: "VALIDATE_SELECTOR", field, selector } satisfies RuntimeMessage, { frameId });
      if (!best || result.matchCount > best.matchCount || result.visibleCount > best.visibleCount) best = result;
    } catch { /* this frame may not contain an injected monitor */ }
  }
  return best ?? {
    ok: false, syntacticallyValid: true, matchCount: 0, visibleCount: 0, riskyCount: 0,
    frameUrl: "", warning: "", error: "The monitor is not active on an open tab for this site. Enable the site and reload it first."
  };
}

async function snoozeTab(tabId: number, until: number | null) {
  beginTabControlMutation(tabId);
  try {
    const canceled = await recoveryCoordinator.cancelCurrent(
      tabId, until === null ? "Monitoring resumed with a fresh recovery state" : "Monitoring was snoozed by the viewer"
    );
    if (canceled) await finalizeCanceledRecovery(tabId, canceled, canceled.terminalReason ?? "Monitoring state changed");
    const committed = (await recoveryCoordinator.getPendingActions())
      .find((pending) => pending.tabId === tabId && pending.action.state === "INITIATED");
    if (committed) {
      return { ok: false, error: "A recovery action has already started; wait for it to finish before changing snooze state" };
    }
    await withLoopLock(async () => {
      const store = await getLoopStore();
      let pageUrl = "";
      try { pageUrl = (await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)).url ?? ""; } catch { /* blank */ }
      const entry = normalizedLoopEntry(store[String(tabId)], pageUrl);
      entry.snoozedUntil = until;
      store[String(tabId)] = entry;
      await setLoopStore(store);
    });
    await safeSendAll(tabId, { type: "SNOOZE_UNTIL", until });
    await appendHistory({ event: until === null ? "monitoring-resumed" : "monitoring-snoozed", detail: until === -1 ? "Paused until resumed" : until ? `Snoozed until ${new Date(until).toLocaleString()}` : "Monitoring resumed", level: "info", url: "", tabId });
    return { ok: true };
  } finally {
    endTabControlMutation(tabId);
  }
}
async function resetTabAttempts(tabId: number) {
  beginTabControlMutation(tabId);
  try {
    const reset = await recoveryCoordinator.resetTab(tabId);
    if (!reset.reset) {
      return { ok: false, error: "A recovery action has already started and cannot be reset safely" };
    }
    for (const canceled of reset.canceled) {
      await clearRecoveryAlarm(canceled.id);
      if (canceled.state === "CANCELED") {
        await safeSendAll(tabId, stopCountdownMessage(canceled, "Recovery attempts reset by the viewer", true));
      }
    }
    await withLoopLock(async () => {
      const store = await getLoopStore();
      const entry = store[String(tabId)];
      if (entry) { entry.attempts = []; entry.actionAttempts = {}; entry.pausedUntil = null; await setLoopStore(store); }
    });
    await safeSendAll(tabId, { type: "RETRY_MONITORING" });
    return { ok: true };
  } finally {
    endTabControlMutation(tabId);
  }
}

async function savePreferences(origin: string, preferences: PlayerPreferences) {
  const store = await getPreferencesStore();
  store[origin] = preferences;
  const keys = Object.keys(store);
  if (keys.length > 100) delete store[keys[0]];
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [PREFERENCES_KEY]: store });
  return { ok: true };
}

async function getSiteModels(): Promise<Record<string, LocalSiteModel>> {
  const stored = await apiCall<Record<string, unknown>>(ext.storage.local.get, ext.storage.local, SITE_MODEL_KEY);
  return stored[SITE_MODEL_KEY] && typeof stored[SITE_MODEL_KEY] === "object" ? stored[SITE_MODEL_KEY] as Record<string, LocalSiteModel> : {};
}
async function getSiteModel(origin: string): Promise<LocalSiteModel> { return (await getSiteModels())[origin] ?? emptySiteModel(origin); }
async function recordActionOutcome(origin: string, outcome: Parameters<typeof addActionOutcome>[1]) {
  const models = await getSiteModels();
  models[origin] = addActionOutcome(models[origin] ?? emptySiteModel(origin), outcome);
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [SITE_MODEL_KEY]: trimModels(models) });
  return { ok: true, model: models[origin] };
}
async function recordHealthSample(origin: string, sample: Parameters<typeof addHealthSample>[1]) {
  const models = await getSiteModels();
  models[origin] = addHealthSample(models[origin] ?? emptySiteModel(origin), sample);
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [SITE_MODEL_KEY]: trimModels(models) });
  return { ok: true, model: models[origin] };
}
async function recordSessionVisit(origin: string, tabId: number): Promise<LocalSiteModel> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, SESSION_SEEN_KEY);
  const seen = stored[SESSION_SEEN_KEY] && typeof stored[SESSION_SEEN_KEY] === "object"
    ? stored[SESSION_SEEN_KEY] as Record<string, number> : {};
  const key = `${tabId}:${origin}`;
  const model = await getSiteModel(origin);
  if (seen[key]) return model;
  seen[key] = Date.now();
  for (const [entry, timestamp] of Object.entries(seen)) if (Date.now() - timestamp > 24 * 60 * 60_000) delete seen[entry];
  const models = await getSiteModels();
  models[origin] = addSession(models[origin] ?? model);
  await Promise.all([
    apiCall<void>(area.set, area, { [SESSION_SEEN_KEY]: seen }),
    apiCall<void>(ext.storage.local.set, ext.storage.local, { [SITE_MODEL_KEY]: trimModels(models) })
  ]);
  return models[origin];
}
async function recordUserFeedback(origin: string, correct: boolean, failureKind: Parameters<typeof addUserFeedback>[2]) {
  const models = await getSiteModels();
  models[origin] = addUserFeedback(models[origin] ?? emptySiteModel(origin), correct, failureKind);
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [SITE_MODEL_KEY]: trimModels(models) });
  return { ok: true, model: models[origin] };
}
function trimModels(models: Record<string, LocalSiteModel>): Record<string, LocalSiteModel> {
  return Object.fromEntries(Object.entries(models).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 100));
}

async function getProfiles(): Promise<SiteProfile[]> {
  const stored = await apiCall<Record<string, unknown>>(ext.storage.local.get, ext.storage.local, PROFILE_KEY);
  return Array.isArray(stored[PROFILE_KEY]) ? stored[PROFILE_KEY] as SiteProfile[] : [];
}
async function saveProfile(input: SiteProfile) {
  const profile = normalizeProfile(input);
  const profiles = await getProfiles();
  const index = profiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) profiles[index] = profile; else profiles.push(profile);
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [PROFILE_KEY]: profiles.slice(-100) });
  return { ok: true, profile };
}
async function deleteProfile(profileId: string) {
  const profiles = (await getProfiles()).filter((item) => item.id !== profileId);
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [PROFILE_KEY]: profiles });
  return { ok: true };
}

async function getSessionSnapshots(): Promise<SessionSnapshotStore> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, SNAPSHOT_KEY);
  const snapshots = stored[SNAPSHOT_KEY] && typeof stored[SNAPSHOT_KEY] === "object" ? stored[SNAPSHOT_KEY] as SessionSnapshotStore : {};
  const now = Date.now();
  for (const [key, storedSnapshot] of Object.entries(snapshots)) {
    if (!storedSnapshot?.snapshot || !Number.isInteger(storedSnapshot.frameId) || storedSnapshot.frameId < 0 ||
      storedSnapshot.snapshot.expiresAt <= now) delete snapshots[key];
  }
  return snapshots;
}
async function saveSessionSnapshot(sender: chrome.runtime.MessageSender, snapshot: PlayerSessionSnapshot) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false, error: "No tab context" };
  const frameId = sender.frameId ?? 0;
  const status = currentOwnedStatus(tabId, frameId);
  if (!status || status.origin !== snapshot.origin || status.navigationId !== snapshot.navigationId ||
    status.recoveryCycleId !== snapshot.recoveryCycleId || urlKey(status.pageUrl) !== snapshot.pageUrlKey) {
    return { ok: false, error: "Only the elected recovery executor can save this snapshot" };
  }
  const cycle = await recoveryCoordinator.getCycle(tabId, snapshot.recoveryCycleId);
  if (!cycle || cycle.state !== "ACTIVE" || cycle.ownerFrameId !== frameId || cycle.origin !== snapshot.origin) {
    return { ok: false, error: "The recovery cycle no longer owns this snapshot" };
  }
  await withSnapshotLock(async () => {
    const area = ext.storage.session ?? ext.storage.local;
    const snapshots = await getSessionSnapshots();
    const key = sessionSnapshotKey(tabId, frameId, snapshot.recoveryCycleId, snapshot.pageUrlKey);
    snapshots[key] = {
      tabId, frameId, navigationId: snapshot.navigationId, recoveryCycleId: snapshot.recoveryCycleId,
      pageUrlKey: snapshot.pageUrlKey, savedAt: Date.now(), deliveredAt: null, snapshot
    };
    const entries = Object.entries(snapshots).sort((a, b) => b[1].savedAt - a[1].savedAt);
    for (const [staleKey] of entries.slice(50)) delete snapshots[staleKey];
    await apiCall<void>(area.set, area, { [SNAPSHOT_KEY]: snapshots });
  });
  return { ok: true };
}
async function clearSessionSnapshot(sender: chrome.runtime.MessageSender, origin: string, recoveryCycleId?: string) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false };
  const frameId = sender.frameId ?? 0;
  await withSnapshotLock(async () => {
    const area = ext.storage.session ?? ext.storage.local;
    const snapshots = await getSessionSnapshots();
    for (const [key, storedSnapshot] of Object.entries(snapshots)) {
      if (storedSnapshot.tabId === tabId && storedSnapshot.frameId === frameId && storedSnapshot.snapshot.origin === origin &&
        (!recoveryCycleId || storedSnapshot.recoveryCycleId === recoveryCycleId)) delete snapshots[key];
    }
    await apiCall<void>(area.set, area, { [SNAPSHOT_KEY]: snapshots });
  });
  return { ok: true };
}

function findSessionSnapshot(
  snapshots: SessionSnapshotStore, tabId: number | undefined, frameId: number, pageUrl: string, recoveryCycleId?: string
): PlayerSessionSnapshot | undefined {
  if (tabId === undefined) return undefined;
  const pageKey = urlKey(pageUrl);
  const candidates = Object.values(snapshots)
    .filter((item) => item.tabId === tabId && item.frameId === frameId && item.snapshot.expiresAt > Date.now() &&
      (recoveryCycleId ? item.recoveryCycleId === recoveryCycleId : item.pageUrlKey === pageKey))
    .sort((a, b) => b.savedAt - a.savedAt);
  return candidates[0]?.snapshot;
}

function sessionSnapshotKey(tabId: number, frameId: number, recoveryCycleId: string, pageUrl: string): string {
  return `${tabId}:${frameId}:${recoveryCycleId}:${urlKey(pageUrl)}`;
}

async function deliverSessionSnapshotAfterHandoff(
  tabId: number, frameId: number, status: FrameStatus, recoveryCycleId: string
): Promise<void> {
  const currentSettings = effectiveSettings(await loadSettings(), status.origin);
  if (!currentSettings.enabled || !currentSettings.siteEnabled || !currentSettings.restorePlayerPreferences) return;
  const prepared = await withSnapshotLock(async (): Promise<PlayerSessionSnapshot | null> => {
    const area = ext.storage.session ?? ext.storage.local;
    const snapshots = await getSessionSnapshots();
    const match = Object.entries(snapshots)
      .filter(([, item]) => item.tabId === tabId && item.recoveryCycleId === recoveryCycleId &&
        item.snapshot.origin === status.origin && item.snapshot.expiresAt > Date.now())
      .sort((a, b) => b[1].savedAt - a[1].savedAt)[0];
    if (!match) return null;
    const [oldKey, stored] = match;
    if (stored.deliveredAt && Date.now() - stored.deliveredAt < 5_000) return null;
    delete snapshots[oldKey];
    stored.frameId = frameId;
    stored.navigationId = status.navigationId;
    stored.pageUrlKey = urlKey(status.pageUrl);
    stored.deliveredAt = Date.now();
    snapshots[sessionSnapshotKey(tabId, frameId, recoveryCycleId, status.pageUrl)] = stored;
    await apiCall<void>(area.set, area, { [SNAPSHOT_KEY]: snapshots });
    return stored.snapshot;
  });
  if (!prepared) return;
  try {
    const response = await sendTabMessage<{ ok?: boolean; restored?: boolean }>(
      tabId, { type: "RESTORE_SESSION_SNAPSHOT", snapshot: prepared }, { frameId }
    );
    if (response?.ok === true && response.restored === true) {
      await withSnapshotLock(async () => {
        const area = ext.storage.session ?? ext.storage.local;
        const snapshots = await getSessionSnapshots();
        for (const [key, stored] of Object.entries(snapshots)) {
          if (stored.tabId === tabId && stored.frameId === frameId &&
            stored.recoveryCycleId === recoveryCycleId && stored.snapshot.id === prepared.id) delete snapshots[key];
        }
        await apiCall<void>(area.set, area, { [SNAPSHOT_KEY]: snapshots });
      });
    }
  } catch { /* the next elected-player report may retry after the delivery backoff */ }
}

function withSnapshotLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = snapshotQueue.then(operation, operation);
  snapshotQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function getPreferencesStore(): Promise<Record<string, PlayerPreferences>> {
  const stored = await apiCall<Record<string, unknown>>(ext.storage.local.get, ext.storage.local, PREFERENCES_KEY);
  return stored[PREFERENCES_KEY] && typeof stored[PREFERENCES_KEY] === "object" ? stored[PREFERENCES_KEY] as Record<string, PlayerPreferences> : {};
}

async function appendHistory(entry: Omit<HistoryEvent, "id" | "timestamp">): Promise<void> {
  const settings = await loadSettings();
  if (!settings.localHistoryEnabled) return;
  const item: HistoryEvent = { ...entry, id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, timestamp: Date.now() };
  const task = historyQueue.then(async () => {
    const stored = await apiCall<Record<string, unknown>>(ext.storage.local.get, ext.storage.local, HISTORY_KEY);
    const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] as HistoryEvent[] : [];
    history.push(item);
    await apiCall<void>(ext.storage.local.set, ext.storage.local, { [HISTORY_KEY]: history.slice(-settings.historyLimit) });
  });
  historyQueue = task.then(() => undefined, () => undefined);
  await task;
}
async function getHistory(tabId?: number, limit = 200): Promise<HistoryEvent[]> {
  const stored = await apiCall<Record<string, unknown>>(ext.storage.local.get, ext.storage.local, HISTORY_KEY);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] as HistoryEvent[] : [];
  return history.filter((item) => tabId === undefined || item.tabId === tabId).slice(-Math.max(1, Math.min(1000, limit))).reverse();
}
async function clearHistory(tabId?: number) {
  if (tabId === undefined) await apiCall<void>(ext.storage.local.set, ext.storage.local, { [HISTORY_KEY]: [] });
  else {
    const all = await getHistory(undefined, 1000);
    await apiCall<void>(ext.storage.local.set, ext.storage.local, { [HISTORY_KEY]: all.filter((item) => item.tabId !== tabId).reverse() });
  }
  return { ok: true };
}

async function clearData(target: DataClearTarget) {
  if (target === "all") {
    clearingAllData = true;
    try {
      const tabs = await apiCall<chrome.tabs.Tab[]>(ext.tabs.query, ext.tabs, {}).catch(() => []);
      const tabIds = tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
      const pending = await recoveryCoordinator.getPendingActions().catch(() => []);
      await Promise.all(pending.map(({ action }) => clearRecoveryAlarm(action.id)));
      await Promise.all(tabIds.map((id) => safeSendAll(id, { type: "SHUTDOWN_MONITOR" })));
      await unregisterAllManagedScripts();
      await revokeOptionalPermissions();
      for (const id of [...protectedTabs]) await updateDiscardProtection(id, false);
      runtimeTabs.clear();
      primaryLeases.clear();
      await Promise.all([
        apiCall<void>(ext.storage.sync.clear, ext.storage.sync),
        apiCall<void>(ext.storage.local.clear, ext.storage.local),
        ext.storage.session ? apiCall<void>(ext.storage.session.clear, ext.storage.session) : Promise.resolve()
      ]);
      settingsCache = null;
      await Promise.all(tabIds.map((id) => setBadge(id, "", "#6b7280")));
    } finally { clearingAllData = false; }
    return { ok: true, target };
  }
  if (target === "history") return clearHistory();
  if (target === "models") await apiCall<void>(ext.storage.local.remove, ext.storage.local, SITE_MODEL_KEY);
  if (target === "preferences") await apiCall<void>(ext.storage.local.remove, ext.storage.local, PREFERENCES_KEY);
  if (target === "profiles") await apiCall<void>(ext.storage.local.remove, ext.storage.local, PROFILE_KEY);
  if (target === "runtime") {
    const pending = await recoveryCoordinator.getPendingActions().catch(() => []);
    await Promise.all(pending.map(({ action }) => clearRecoveryAlarm(action.id)));
    const liveTabIds = [...runtimeTabs.keys()];
    await Promise.all(liveTabIds.map((tabId) => safeSendAll(tabId, { type: "RESET_RUNTIME_STATE" })));
    const area = ext.storage.session ?? ext.storage.local;
    await apiCall<void>(area.remove, area, [LOOP_KEY, STATUS_KEY, SNAPSHOT_KEY, SESSION_SEEN_KEY, RECOVERY_LEDGER_KEY]);
    runtimeTabs.clear();
    primaryLeases.clear();
    for (const tabId of [...protectedTabs]) await updateDiscardProtection(tabId, false);
  }
  return { ok: true, target };
}

async function revokeOptionalPermissions(): Promise<void> {
  if (!ext.permissions?.getAll) return;
  try {
    const granted = await apiCall<chrome.permissions.Permissions>(ext.permissions.getAll, ext.permissions);
    const removable: chrome.permissions.Permissions = {};
    if (granted.origins?.length) removable.origins = granted.origins;
    const optional = (granted.permissions ?? []).filter((permission) => permission === "notifications");
    if (optional.length) removable.permissions = optional;
    if (removable.origins?.length || removable.permissions?.length) {
      await apiCall<boolean>(ext.permissions.remove, ext.permissions, removable);
    }
  } catch { /* browser may already have removed optional grants */ }
}

async function unregisterAllManagedScripts(): Promise<void> {
  return withRegistrationLock(unregisterAllManagedScriptsUnlocked);
}
async function unregisterAllManagedScriptsUnlocked(): Promise<void> {
  if (!ext.scripting?.getRegisteredContentScripts) return;
  try {
    const scripts = await apiCall<chrome.scripting.RegisteredContentScript[]>(ext.scripting.getRegisteredContentScripts, ext.scripting);
    const ids = scripts.map((script) => script.id).filter((id) => id.startsWith(REGISTRATION_PREFIX) || id.startsWith(BRIDGE_REGISTRATION_PREFIX));
    if (ids.length) await apiCall<void>(ext.scripting.unregisterContentScripts, ext.scripting, { ids });
  } catch { /* best-effort data reset */ }
}

async function updateBadge(tabId: number, status: FrameStatus): Promise<void> {
  const settings = await loadSettings();
  const show = status.origin ? effectiveSettings(settings, status.origin).showBadge : settings.showBadge;
  if (!show) { await setBadge(tabId, "", "#6b7280"); return; }
  const badge: Partial<Record<MonitorState, [string, string]>> = {
    HEALTHY: ["OK", "#198754"], MONITORING: ["…", "#5865a8"], LIMITED_VISIBILITY: ["?", "#6b7280"], NO_VIDEO_FOUND: ["—", "#6b7280"],
    OFFLINE: ["OFF", "#6b7280"], SNOOZED: ["Z", "#6b7280"], URL_EXCLUDED: ["—", "#6b7280"],
    SUSPECTED_DOWN: ["!", "#d97706"], RECOVERING: ["↻", "#6f48e8"], COUNTDOWN: ["!", "#d97706"],
    REFRESHING: ["↻", "#6f48e8"], PAUSED_TOO_MANY_REFRESHES: ["×", "#b42318"], ERROR: ["!", "#b42318"], MAXIMIZE_BLOCKED: ["↗", "#d97706"]
  };
  const [text, color] = badge[status.state] ?? ["", "#6b7280"];
  await setBadge(tabId, text, color);
}
async function setBadge(tabId: number, text: string, color: string) {
  try { await apiCall<void>(ext.action.setBadgeText, ext.action, { tabId, text }); if (text) await apiCall<void>(ext.action.setBadgeBackgroundColor, ext.action, { tabId, color }); }
  catch { /* restricted page */ }
}
async function maybeNotify(title: string, message: string, settings: EffectiveSettings) {
  if (!settings.showNotifications || !ext.notifications) return;
  try {
    if (!await apiCall<boolean>(ext.permissions.contains, ext.permissions, { permissions: ["notifications"] })) return;
    await apiCall<string>(ext.notifications.create, ext.notifications, { type: "basic", iconUrl: "icon-128.png", title, message });
  } catch { /* optional */ }
}

async function broadcastSettings(settings: Settings) {
  const pending = await recoveryCoordinator.getPendingActions();
  for (const { tabId, action } of pending) {
    if (action.state === "COUNTDOWN" || action.state === "AUTHORIZED") {
      await cancelScheduledRecovery(tabId, action, "Settings changed before the pending recovery action ran");
    }
  }
  let tabs: chrome.tabs.Tab[] = [];
  try { tabs = await apiCall(ext.tabs.query, ext.tabs, {}); } catch { return; }
  const delivered = new Set<string>();
  const sends: Promise<void>[] = [];
  for (const [tabId, state] of runtimeTabs) {
    for (const [frameId, status] of state.frames) {
      const key = `${tabId}:${frameId}`;
      delivered.add(key);
      sends.push(safeSend(tabId, { type: "SETTINGS_CHANGED", settings: effectiveSettings(settings, status.origin) }, frameId));
    }
  }
  for (const tab of tabs) {
    const origin = getOrigin(tab.url);
    if (tab.id === undefined || !origin || delivered.has(`${tab.id}:0`)) continue;
    sends.push(safeSend(tab.id, { type: "SETTINGS_CHANGED", settings: effectiveSettings(settings, origin) }, 0));
  }
  await Promise.all(sends);
}
async function safeSend(tabId: number, message: RuntimeMessage, frameId = 0) { try { await sendTabMessage(tabId, message, { frameId }); } catch { /* unavailable */ } }
async function safeSendAll(tabId: number, message: RuntimeMessage) { try { await sendTabMessage(tabId, message); } catch { /* unavailable */ } }

function selectBestStatus(tabId: number): FrameStatus | undefined {
  pruneRuntimeFrames(tabId);
  const owner = primaryLeases.ownerStatus(tabId);
  if (owner) return owner;
  const values = [...(runtimeTabs.get(tabId)?.frames.values() ?? [])].filter((item) => Date.now() - item.updatedAt < 45_000);
  const priority: MonitorState[] = ["PAUSED_TOO_MANY_REFRESHES", "COUNTDOWN", "SUSPECTED_DOWN", "RECOVERING", "ERROR"];
  for (const state of priority) { const match = values.find((item) => item.state === state); if (match) return match; }
  return values.sort((a, b) => (b.hasVideo ? b.score : -1) - (a.hasVideo ? a.score : -1))[0];
}
function selectBestFrame(tabId: number): number {
  pruneRuntimeFrames(tabId);
  const lease = primaryLeases.get(tabId);
  if (lease) return lease.frameId;
  return [...(runtimeTabs.get(tabId)?.frames.entries() ?? [])]
    .filter(([, item]) => item.hasVideo && Date.now() - item.updatedAt < 45_000)
    .sort((a, b) => b[1].score - a[1].score)[0]?.[0] ?? 0;
}

function isFreshDashboardStatus(status: FrameStatus, now: number): boolean {
  return Number.isFinite(status.updatedAt) && status.updatedAt > 0 && status.updatedAt <= now + 60_000
    && now - status.updatedAt <= 45_000 && typeof status.origin === "string"
    && (status.origin === "file://" || getOrigin(status.origin) === status.origin)
    && typeof status.detail === "string" && Number.isFinite(status.confidence);
}

function getTabState(tabId: number): TabRuntimeState {
  let state = runtimeTabs.get(tabId);
  if (!state) { state = { frames: new Map() }; runtimeTabs.set(tabId, state); }
  return state;
}
function pruneRuntimeFrames(tabId: number, now = Date.now()): void {
  const tab = runtimeTabs.get(tabId);
  if (!tab) return;
  for (const [frameId, status] of tab.frames) {
    if (now - status.updatedAt <= 45_000) continue;
    tab.frames.delete(frameId);
    primaryLeases.removeFrame(tabId, frameId);
    void reconcileLostRecoveryExecutors(tabId, {
      frameId, navigationId: status.navigationId, candidateId: status.candidateId,
      candidateEpoch: status.candidateEpoch
    }, "The recovery executor stopped reporting and its frame status expired");
  }
  if (!tab.frames.size && !tab.countdownSourceFrame) runtimeTabs.delete(tabId);
}
function defaultStatus(settings: Settings, origin: string | null): FrameStatus {
  const state: MonitorState = !settings.enabled ? "DISABLED" : !origin || !settings.perSite[origin]?.enabled ? "SITE_NOT_ENABLED" : "MONITORING";
  const detail = state === "DISABLED" ? "Extension is globally disabled" : state === "SITE_NOT_ENABLED" ? "Enable monitoring for this site" : "Waiting for a status update";
  return {
    state, detail, pageUrl: "", origin: origin ?? "", hasVideo: false, score: 0, confidence: 0, evidence: [], selectedVideoLabel: "",
    diagnosis: healthyDiagnosis(), streamKind: "UNKNOWN", liveIntent: "UNKNOWN_LIVE_POSITION", liveEdgeLagSeconds: null, bufferAheadSeconds: null,
    recoveryCycleId: null, circuitState: "CLOSED", compatibility: emptyCompatibility(), recoveryAction: null, nextActionAt: null,
    online: true, pageVisible: true, frameToken: "", navigationId: "waiting", candidateId: "", candidateEpoch: 0,
    updatedAt: Date.now()
  };
}
function statusLevel(state: MonitorState): HistoryEvent["level"] {
  if (state === "HEALTHY") return "success";
  if (["ERROR", "PAUSED_TOO_MANY_REFRESHES"].includes(state)) return "error";
  if (["SUSPECTED_DOWN", "RECOVERING", "COUNTDOWN", "REFRESHING", "OFFLINE"].includes(state)) return "warning";
  return "info";
}

async function handleCommand(command: string): Promise<void> {
  const tab = await queryActiveTab();
  if (tab?.id === undefined) return;
  const origin = getOrigin(tab.url);
  if (command === "refresh-stream" && origin) await manualRefresh(tab.id, origin);
  else if (command === "maximize-stream") await manualMaximize(tab.id);
  else if (command === "toggle-monitoring") {
    const entry = (await getLoopStore())[String(tab.id)];
    await snoozeTab(tab.id, entry?.snoozedUntil ? null : -1);
  } else if (command === "cancel-refresh") {
    await cancelAutoRefresh(tab.id);
  }
}

function registrationId(origin: string): string {
  let hash = 2166136261;
  for (let i = 0; i < origin.length; i += 1) { hash ^= origin.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${REGISTRATION_PREFIX}${(hash >>> 0).toString(36)}`;
}
function bridgeRegistrationId(origin: string): string { return registrationId(origin).replace(REGISTRATION_PREFIX, BRIDGE_REGISTRATION_PREFIX); }
function withLoopLock<T>(task: () => Promise<T>): Promise<T> {
  const result = loopQueue.then(task, task); loopQueue = result.then(() => undefined, () => undefined); return result;
}
function beginTabControlMutation(tabId: number): void {
  tabControlMutationCounts.set(tabId, (tabControlMutationCounts.get(tabId) ?? 0) + 1);
}
function endTabControlMutation(tabId: number): void {
  const remaining = (tabControlMutationCounts.get(tabId) ?? 1) - 1;
  if (remaining <= 0) tabControlMutationCounts.delete(tabId);
  else tabControlMutationCounts.set(tabId, remaining);
}
function tabControlMutationActive(tabId: number): boolean {
  return (tabControlMutationCounts.get(tabId) ?? 0) > 0;
}
async function getLoopStore(): Promise<LoopStore> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, LOOP_KEY);
  return stored[LOOP_KEY] && typeof stored[LOOP_KEY] === "object" ? stored[LOOP_KEY] as LoopStore : {};
}

async function getRecoveryLedgerStore(): Promise<RecoveryLedgerStore> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, RECOVERY_LEDGER_KEY);
  const value = stored[RECOVERY_LEDGER_KEY];
  return value && typeof value === "object" ? value as RecoveryLedgerStore : emptyRecoveryStore();
}

async function setRecoveryLedgerStore(store: RecoveryLedgerStore): Promise<void> {
  const area = ext.storage.session ?? ext.storage.local;
  await apiCall<void>(area.set, area, { [RECOVERY_LEDGER_KEY]: store });
}

async function scheduleRecoveryAlarm(tabId: number, actionId: string, deadline: number): Promise<void> {
  if (!ext.alarms?.create) return;
  try {
    const result = ext.alarms.create(recoveryAlarmName(tabId, actionId), { when: Math.max(Date.now() + 50, deadline) });
    if (result && typeof (result as Promise<void>).then === "function") await result;
  } catch { /* the in-page deadline remains a safe one-use fallback */ }
}

async function restoreRecoveryAlarms(): Promise<void> {
  const pending = await recoveryCoordinator.getPendingActions();
  for (const { tabId, action } of pending) {
    if (action.state === "COUNTDOWN" && action.displayFrameId === null) {
      await cancelScheduledRecovery(tabId, action, "The restored recovery had no verified visible countdown route");
      continue;
    }
    const deadline = action.state === "COUNTDOWN" && action.countdownDeadline !== null
      ? action.countdownDeadline : action.expiresAt;
    await scheduleRecoveryAlarm(tabId, action.id, deadline);
  }
}

async function clearRecoveryAlarm(actionId: string): Promise<void> {
  if (!ext.alarms?.clear) return;
  try {
    const alarms = await apiCall<chrome.alarms.Alarm[]>(ext.alarms.getAll, ext.alarms);
    await Promise.all(alarms.filter((alarm) => alarm.name.endsWith(`:${actionId}`))
      .map((alarm) => apiCall<boolean>(ext.alarms.clear, ext.alarms, alarm.name)));
  } catch { /* already absent or unsupported */ }
}

function recoveryAlarmName(tabId: number, actionId: string): string {
  return `${RECOVERY_ALARM_PREFIX}${tabId}:${actionId}`;
}

function parseRecoveryAlarmName(name: string): { tabId: number; actionId: string } | null {
  if (!name.startsWith(RECOVERY_ALARM_PREFIX)) return null;
  const value = name.slice(RECOVERY_ALARM_PREFIX.length);
  const separator = value.indexOf(":");
  const tabId = Number(value.slice(0, separator));
  const actionId = value.slice(separator + 1);
  return separator > 0 && Number.isInteger(tabId) && tabId >= 0 && actionId.length > 0 ? { tabId, actionId } : null;
}
async function setLoopStore(store: LoopStore) {
  const now = Date.now();
  for (const [id, entry] of Object.entries(store)) {
    const newest = Math.max(entry.pendingMaximizeAt ?? 0, entry.eventModeUntil ?? 0, ...entry.attempts, ...Object.values(entry.actionAttempts ?? {}).flat(), 0);
    if (entry.snoozedUntil !== -1 && now - Math.max(newest, entry.snoozedUntil ?? 0) > 24 * 60 * 60_000) delete store[id];
  }
  const area = ext.storage.session ?? ext.storage.local;
  await apiCall<void>(area.set, area, { [LOOP_KEY]: store });
}

async function setEventMode(tabId: number, until: number | null) {
  await withLoopLock(async () => {
    const store = await getLoopStore();
    let pageUrl = ""; try { pageUrl = (await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)).url ?? ""; } catch { /* unavailable */ }
    const entry = normalizedLoopEntry(store[String(tabId)], pageUrl); entry.eventModeUntil = until; store[String(tabId)] = entry; await setLoopStore(store);
  });
  await appendHistory({ event: until ? "event-mode-started" : "event-mode-ended", detail: until ? `High-reliability event mode until ${new Date(until).toLocaleString()}` : "Event mode ended", level: "info", url: "", tabId });
  await safeSendAll(tabId, { type: "EVENT_MODE_UNTIL", until });
  if (until && until > Date.now()) await updateDiscardProtection(tabId, true);
  else {
    const status = selectBestStatus(tabId);
    const protect = status ? effectiveSettings(await loadSettings(), status.origin).protectTabFromDiscard : false;
    await updateDiscardProtection(tabId, protect);
  }
  return { ok: true };
}

async function updateDiscardProtection(tabId: number, protect: boolean): Promise<void> {
  if (protectedTabs.has(tabId) === protect) return;
  try { await apiCall<chrome.tabs.Tab>(ext.tabs.update, ext.tabs, tabId, { autoDiscardable: !protect } as chrome.tabs.UpdateProperties); }
  catch { /* unsupported or restricted */ }
  if (protect) protectedTabs.add(tabId); else protectedTabs.delete(tabId);
}

async function captureVisualSample(
  sender: chrome.runtime.MessageSender,
  message: Extract<RuntimeMessage, { type: "REQUEST_VISUAL_SAMPLE" }>
) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  const senderOrigin = getOrigin(sender.url);
  if (tabId === undefined || !senderOrigin || senderOrigin !== message.origin || getOrigin(message.pageUrl) !== senderOrigin) {
    return { ok: false, error: "Visual sampling is unavailable for this sender." };
  }

  const [settings, disclaimerAcknowledged, visualPrivacyAcknowledged, tab] = await Promise.all([
    loadSettings(), getDisclaimerAcknowledged(), getVisualPrivacyAcknowledged(),
    apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId).catch(() => null)
  ]);
  const effective = effectiveSettings(settings, senderOrigin);
  const owner = primaryLeases.ownerStatus(tabId);
  const permissionPattern = originPattern(senderOrigin);
  const exactOriginPermission = !!permissionPattern && await hasExactOriginPermission(permissionPattern);
  const now = Date.now();
  const decision = decideVisualSampleAccess({
    frameId,
    senderActive: sender.tab?.active === true,
    tabActive: tab?.active === true && tab.discarded !== true,
    pageVisible: owner?.pageVisible === true,
    disclaimerAcknowledged,
    visualPrivacyAcknowledged,
    globalEnabled: settings.enabled,
    siteEnabled: effective.siteEnabled,
    featureEnabled: effective.enableVisualWatchdog,
    urlEnabled: isUrlEnabled(message.pageUrl, effective),
    exactOriginPermission,
    primaryOwner: primaryLeases.owns(tabId, frameId, message.navigationId, message.candidateId, message.candidateEpoch, now),
    originMatchesOwner: owner?.origin === senderOrigin,
    pageMatchesOwner: owner?.pageUrl === message.pageUrl,
    inFlight: visualSampleInFlight.has(tabId),
    lastSampleAt: visualLastSampleAt.get(tabId) ?? null,
    now,
    intervalMs: Math.max(MIN_VISUAL_SAMPLE_INTERVAL_MS, effective.visualSampleIntervalSeconds * 1_000)
  });
  if (!decision.ok) return decision;

  // Set the clock before capture so concurrent/retried messages cannot create a
  // screenshot burst. The screenshot string never crosses this function's
  // privileged boundary and is released as soon as hashing completes.
  visualLastSampleAt.set(tabId, now);
  visualSampleInFlight.add(tabId);
  let capturedDataUrl: string | null = null;
  try {
    const immediatelyActive = await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId).catch(() => null);
    if (!immediatelyActive?.active || immediatelyActive.discarded === true || immediatelyActive.windowId !== sender.tab!.windowId) {
      return { ok: false, unavailable: true, error: "Visual sampling requires the active visible tab." };
    }
    capturedDataUrl = await apiCall<string>(ext.tabs.captureVisibleTab, ext.tabs, sender.tab!.windowId, { format: "jpeg", quality: 40 });
    const hash = await hashCapturedVisual(capturedDataUrl, message.rect, message.viewport);
    if (!hash) return { ok: false, unavailable: true, error: "Visual hashing is unavailable in this browser context." };

    // captureVisibleTab targets a window rather than a tab. Revalidate after
    // capture so a tab switch, permission revocation, settings change, or lease
    // handoff during the asynchronous bitmap work causes the result to be
    // discarded instead of exposing even the bounded hash to the old executor.
    const [latestSettings, latestDisclaimer, latestVisualAcknowledgement, latestTab] = await Promise.all([
      loadSettings(true), getDisclaimerAcknowledged(), getVisualPrivacyAcknowledged(),
      apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId).catch(() => null)
    ]);
    const latestEffective = effectiveSettings(latestSettings, senderOrigin);
    const latestOwner = primaryLeases.ownerStatus(tabId);
    const finalDecision = decideVisualSampleAccess({
      frameId,
      senderActive: latestTab?.active === true,
      tabActive: latestTab?.active === true && latestTab.discarded !== true && latestTab.windowId === sender.tab!.windowId,
      pageVisible: latestOwner?.pageVisible === true,
      disclaimerAcknowledged: latestDisclaimer,
      visualPrivacyAcknowledged: latestVisualAcknowledgement,
      globalEnabled: latestSettings.enabled,
      siteEnabled: latestEffective.siteEnabled,
      featureEnabled: latestEffective.enableVisualWatchdog,
      urlEnabled: isUrlEnabled(message.pageUrl, latestEffective),
      exactOriginPermission: !!permissionPattern && await hasExactOriginPermission(permissionPattern),
      primaryOwner: primaryLeases.owns(tabId, frameId, message.navigationId, message.candidateId, message.candidateEpoch),
      originMatchesOwner: latestOwner?.origin === senderOrigin,
      pageMatchesOwner: latestOwner?.pageUrl === message.pageUrl,
      inFlight: false,
      lastSampleAt: null,
      now: Date.now(),
      intervalMs: MIN_VISUAL_SAMPLE_INTERVAL_MS
    });
    if (!finalDecision.ok) return { ...finalDecision, unavailable: true };
    return { ok: true, hash };
  } catch {
    return { ok: false, unavailable: true, error: "The browser did not allow a visual sample." };
  } finally {
    capturedDataUrl = null;
    visualSampleInFlight.delete(tabId);
  }
}

async function hasExactOriginPermission(pattern: string): Promise<boolean> {
  try {
    const permissions = await apiCall<chrome.permissions.Permissions>(ext.permissions.getAll, ext.permissions);
    return permissions.origins?.includes(pattern) === true;
  } catch {
    return false;
  }
}

function emptyCompatibility(): FrameStatus["compatibility"] {
  return { htmlVideo: false, crossFrame: false, frameCallbacks: false, playbackQuality: false, liveEdge: false, pictureInPicture: false, fullscreen: false, wakeLock: false, protocolBridge: false, visualWatchdog: false, playerType: "AUTO", level: "RESTRICTED", limitations: ["No active player report"] };
}
async function persistStatus(tabId: number, status: FrameStatus) {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, STATUS_KEY);
  const statuses = stored[STATUS_KEY] && typeof stored[STATUS_KEY] === "object" ? stored[STATUS_KEY] as StatusStore : {};
  statuses[String(tabId)] = status;
  await apiCall<void>(area.set, area, { [STATUS_KEY]: statuses });
}
async function getStatusStore(): Promise<StatusStore> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, STATUS_KEY);
  return stored[STATUS_KEY] && typeof stored[STATUS_KEY] === "object" ? stored[STATUS_KEY] as StatusStore : {};
}
async function removePersistedStatus(tabId: number): Promise<void> {
  const statuses = await getStatusStore();
  if (!(String(tabId) in statuses)) return;
  delete statuses[String(tabId)];
  const area = ext.storage.session ?? ext.storage.local;
  await apiCall<void>(area.set, area, { [STATUS_KEY]: statuses });
}
async function removeTabState(tabId: number) {
  visualSampleInFlight.delete(tabId);
  visualLastSampleAt.delete(tabId);
  const countdown = await recoveryCoordinator.getCountdown(tabId);
  if (countdown) await clearRecoveryAlarm(countdown.id);
  await recoveryCoordinator.removeTab(tabId);
  await withLoopLock(async () => { const store = await getLoopStore(); delete store[String(tabId)]; await setLoopStore(store); });
  const area = ext.storage.session ?? ext.storage.local;
  const statuses = await getStatusStore(); delete statuses[String(tabId)];
  const snapshots = await getSessionSnapshots();
  for (const [key, snapshot] of Object.entries(snapshots)) if (snapshot.tabId === tabId) delete snapshots[key];
  await apiCall<void>(area.set, area, { [STATUS_KEY]: statuses, [SNAPSHOT_KEY]: snapshots });
}

async function finalizeRemovedTab(tabId: number): Promise<void> {
  await reconcileLostRecoveryExecutors(tabId, {}, "The tab closed before the recovery executor reported a result");
  await removeTabState(tabId);
}
