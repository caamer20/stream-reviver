import { addAsyncMessageListener, apiCall, ext, getOrigin, originPattern, queryActiveTab, sendTabMessage } from "../shared/api";
import { authorizeRuntimeMessage } from "../shared/authorization";
import { effectiveSettings, getDisclaimerAcknowledged, getSettings, getVisualPrivacyAcknowledged, setDisclaimerAcknowledged, setSettings, setVisualPrivacyAcknowledged } from "../shared/settings";
import { addActionOutcome, addHealthSample, addSession, addUserFeedback, emptySiteModel } from "../shared/outcomes";
import { normalizeProfile } from "../shared/profiles";
import { healthyDiagnosis } from "../shared/diagnosis";
import { loopUrlKey as urlKey, normalizeLoopEntry as normalizedLoopEntry, type LoopEntry } from "../shared/loop-policy";
import type {
  DataClearTarget, EffectiveSettings, FrameStatus, GlobalSettings, HistoryEvent, LocalSiteModel, MonitorState, PlayerPreferences,
  PlayerSessionSnapshot, PopupState, RuntimeMessage, SelectorField, SelectorValidationResult, Settings, SiteProfile, SiteSettings
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
const MAX_PENDING_AGE = 2 * 60_000;

interface TabRuntimeState {
  frames: Map<number, FrameStatus>;
  countdownSourceFrame?: number;
  lastHistoryKey?: string;
}
type LoopStore = Record<string, LoopEntry>;
type StatusStore = Record<string, FrameStatus>;

const runtimeTabs = new Map<number, TabRuntimeState>();
const protectedTabs = new Set<number>();
let loopQueue: Promise<void> = Promise.resolve();
let historyQueue: Promise<void> = Promise.resolve();
let registrationQueue: Promise<void> = Promise.resolve();
let settingsCache: Settings | null = null;
let clearingAllData = false;

ext.runtime.onInstalled.addListener((details) => void initialize(details.reason === "install"));
ext.runtime.onStartup?.addListener(() => void initialize(false));
ext.tabs.onRemoved.addListener((tabId) => {
  runtimeTabs.delete(tabId);
  protectedTabs.delete(tabId);
  void removeTabState(tabId);
});
ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.streamReviverSettings) {
    settingsCache = null;
    if (clearingAllData) return;
    void loadSettings().then(async (settings) => {
      await syncRegistrations(settings);
      await broadcastSettings(settings);
    });
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
    case "GET_CONTEXT": return getContentContext(message.origin, message.pageUrl, sender.tab?.id);
    case "GET_POPUP_STATE": return getPopupState(message.tabId, message.origin);
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
    case "CANCEL_AUTO_REFRESH": return cancelAutoRefresh(sender.tab?.id);
    case "PLAYBACK_SUCCESS": return clearAfterSuccess(sender.tab?.id, message.pageUrl);
    case "RECORD_ACTION_OUTCOME": return recordActionOutcome(message.origin, message.outcome);
    case "RECORD_HEALTH_SAMPLE": return recordHealthSample(message.origin, message.sample);
    case "RECORD_USER_FEEDBACK": return recordUserFeedback(message.origin, message.correct, message.failureKind);
    case "SAVE_SESSION_SNAPSHOT": return saveSessionSnapshot(message.snapshot);
    case "CLEAR_SESSION_SNAPSHOT": return clearSessionSnapshot(message.origin);
    case "CLAIM_AUTO_MAXIMIZE": return claimAutoMaximize(sender.tab?.id, message.pageUrl);
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
    case "EXTEND_COUNTDOWN": await safeSend(message.tabId, { type: "EXTEND_COUNTDOWN_IN_PAGE", seconds: message.seconds }); return { ok: true };
    case "CANCEL_TAB_COUNTDOWN": await safeSend(message.tabId, { type: "STOP_COUNTDOWN", reason: "Countdown canceled from popup" }); return cancelAutoRefresh(message.tabId);
    case "REQUEST_VISUAL_SAMPLE": return captureVisualSample(sender, message.rect);
    default: return { ok: false, error: "Unknown message" };
  }
});

void initialize(false);

async function initialize(firstInstall: boolean): Promise<void> {
  const settings = await loadSettings(true);
  await syncRegistrations(settings);
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

async function getContentContext(origin: string, pageUrl: string, tabId?: number) {
  const [settings, acknowledged, loops, preferences, snapshots] = await Promise.all([
    loadSettings(), getDisclaimerAcknowledged(), getLoopStore(), getPreferencesStore(), getSessionSnapshots()
  ]);
  const siteModel = tabId === undefined ? await getSiteModel(origin) : await recordSessionVisit(origin, tabId);
  const effective = effectiveSettings(settings, origin);
  const entry = tabId === undefined ? undefined : loops[String(tabId)];
  return {
    acknowledged,
    settings: effective,
    pendingAutoMaximize: !!entry?.pendingMaximizeAt && Date.now() - entry.pendingMaximizeAt < MAX_PENDING_AGE && entry.urlKey === urlKey(pageUrl),
    preferences: preferences[origin],
    snoozedUntil: entry?.snoozedUntil ?? null,
    eventModeUntil: entry?.eventModeUntil ?? null,
    siteModel,
    sessionSnapshot: snapshots[origin]?.expiresAt > Date.now() ? snapshots[origin] : undefined
  };
}

async function getPopupState(tabId?: number, requestedOrigin?: string): Promise<PopupState> {
  const [settings, acknowledged, loops, models] = await Promise.all([loadSettings(), getDisclaimerAcknowledged(), getLoopStore(), getSiteModels()]);
  let origin = requestedOrigin ?? null;
  if (!origin && tabId !== undefined) {
    try { origin = getOrigin((await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)).url); } catch { origin = null; }
  }
  let status = tabId === undefined ? undefined : selectBestStatus(tabId);
  if (!status && tabId !== undefined) status = (await getStatusStore())[String(tabId)];
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
    await Promise.all(matchingTabIds.map((id) => safeSendAll(id, { type: "SHUTDOWN_MONITOR" })));
    await unregisterOrigin(origin);
    for (const id of matchingTabIds) {
      runtimeTabs.delete(id);
      await removeTabState(id);
      await updateDiscardProtection(id, false);
      await setBadge(id, "", "#6b7280");
    }
    try { await apiCall<boolean>(ext.permissions.remove, ext.permissions, { origins: [pattern] }); } catch { /* browser UI can revoke */ }
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

async function syncRegistrations(settings: Settings): Promise<void> {
  return withRegistrationLock(() => syncRegistrationsUnlocked(settings));
}

async function syncRegistrationsUnlocked(settings: Settings): Promise<void> {
  if (!ext.scripting?.registerContentScripts) return;
  let registered: chrome.scripting.RegisteredContentScript[] = [];
  try { registered = await apiCall(ext.scripting.getRegisteredContentScripts, ext.scripting); } catch { return; }
  const expected = new Set<string>();
  for (const [origin, site] of Object.entries(settings.perSite)) if (site.enabled) {
    expected.add(registrationId(origin));
    if (effectiveSettings(settings, origin).enableAdvancedPlayerBridge) expected.add(bridgeRegistrationId(origin));
  }
  const obsolete = registered.map((script) => script.id).filter((id) => id.startsWith(REGISTRATION_PREFIX) && !expected.has(id));
  if (obsolete.length) try { await apiCall<void>(ext.scripting.unregisterContentScripts, ext.scripting, { ids: obsolete }); } catch { /* best effort */ }
  for (const [origin, site] of Object.entries(settings.perSite)) {
    const pattern = originPattern(origin);
    if (site.enabled && pattern && await hasOriginPermission(pattern)) {
      const hasContent = registered.some((script) => script.id === registrationId(origin));
      const wantsBridge = effectiveSettings(settings, origin).enableAdvancedPlayerBridge;
      const hasBridge = registered.some((script) => script.id === bridgeRegistrationId(origin));
      if (!hasContent || wantsBridge !== hasBridge) await registerOriginUnlocked(origin);
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
  const settings = effectiveSettings(await loadSettings(), origin);
  if (settings.enableAdvancedPlayerBridge) {
    const bridge = { id: bridgeRegistrationId(origin), matches: [pattern], js: ["page-bridge.js"], allFrames: true, runAt: "document_start" as const, world: "MAIN" as const };
    try { await apiCall<void>(ext.scripting.registerContentScripts, ext.scripting, [{ ...bridge, persistAcrossSessions: true, matchOriginAsFallback: true } as any]); }
    catch { try { await apiCall<void>(ext.scripting.registerContentScripts, ext.scripting, [bridge as any]); } catch { /* browser lacks MAIN-world registration */ } }
    try {
      const tabs = await apiCall<chrome.tabs.Tab[]>(ext.tabs.query, ext.tabs, {});
      await Promise.all(tabs.filter((tab) => tab.id !== undefined && getOrigin(tab.url) === origin).map((tab) =>
        apiCall(ext.scripting.executeScript, ext.scripting, { target: { tabId: tab.id!, allFrames: true }, files: ["page-bridge.js"], world: "MAIN" }).catch(() => undefined)
      ));
    } catch { /* applies on next navigation */ }
  }
}
async function unregisterOrigin(origin: string): Promise<void> {
  return withRegistrationLock(() => unregisterOriginUnlocked(origin));
}
async function unregisterOriginUnlocked(origin: string): Promise<void> {
  if (!ext.scripting?.unregisterContentScripts) return;
  try { await apiCall<void>(ext.scripting.unregisterContentScripts, ext.scripting, { ids: [registrationId(origin), bridgeRegistrationId(origin)] }); } catch { /* absent */ }
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
    await Promise.all(tabIds.map((id) => safeSendAll(id, { type: "SHUTDOWN_MONITOR" })));
    for (const id of tabIds) {
      runtimeTabs.delete(id);
      await removeTabState(id);
      await updateDiscardProtection(id, false);
      await setBadge(id, "", "#6b7280");
    }
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
  const status = { ...report, updatedAt: Date.now() };
  tab.frames.set(frameId, status);
  const selected = selectBestStatus(tabId) ?? status;
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
  if (tab.countdownSourceFrame === frameId && report.state === "HEALTHY") {
    tab.countdownSourceFrame = undefined;
    await safeSend(tabId, { type: "STOP_COUNTDOWN", reason: "Playback recovered" });
  }
  return { ok: true };
}

async function requestAutoRefresh(sender: chrome.runtime.MessageSender, origin: string, pageUrl: string, reason: string, confidence: number) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false, error: "No tab context" };
  const [settings, acknowledged] = await Promise.all([loadSettings(), getDisclaimerAcknowledged()]);
  const effective = effectiveSettings(settings, origin);
  if (!acknowledged || !effective.enabled || !effective.siteEnabled || !effective.autoRefresh) return { ok: false, error: "Automatic refresh is disabled" };
  const allowance = await inspectAllowance(tabId, pageUrl, effective);
  if (!allowance.allowed) {
    const detail = "Automatic refresh paused: the configured page-reload limit was reached.";
    await safeSend(tabId, { type: "SHOW_LOOP_WARNING", detail });
    await maybeNotify("Stream Reviver paused", detail, effective);
    return allowance;
  }
  const tab = getTabState(tabId);
  if (tab.countdownSourceFrame !== undefined) return { ok: true, alreadyScheduled: true };
  tab.countdownSourceFrame = sender.frameId ?? 0;
  await appendHistory({ event: "countdown-started", detail: reason, level: "warning", url: pageUrl, tabId, frameId: sender.frameId, metadata: { confidence } });
  await safeSend(tabId, { type: "START_COUNTDOWN", seconds: effective.refreshCountdownSeconds, reason });
  return { ok: true };
}

async function recordAutoRefresh(sender: chrome.runtime.MessageSender, origin: string, pageUrl: string) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { allowed: false };
  const settings = effectiveSettings(await loadSettings(), origin);
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
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false };
  const allowed = await recordActionAttempt(tabId, sender.tab?.url ?? "", "IFRAME_RELOAD");
  if (!allowed) return { ok: false, error: "Embedded player reload limit reached" };
  await safeSend(tabId, { type: "RECOVER_IFRAME", frameToken });
  return { ok: true };
}

async function recordActionAttempt(tabId: number, pageUrl: string, action: string): Promise<boolean> {
  const settings = await loadSettings();
  return withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = normalizedLoopEntry(store[String(tabId)], pageUrl);
    const now = Date.now();
    const windowMs = settings.refreshWindowMinutes * 60_000;
    const attempts = (entry.actionAttempts[action] ?? []).filter((time) => now - time < windowMs);
    if (attempts.length >= settings.maxAutoRefreshes) return false;
    attempts.push(now);
    entry.actionAttempts[action] = attempts;
    store[String(tabId)] = entry;
    await setLoopStore(store);
    return true;
  });
}

async function cancelAutoRefresh(tabId?: number) {
  if (tabId !== undefined) getTabState(tabId).countdownSourceFrame = undefined;
  return { ok: true };
}
async function clearAfterSuccess(tabId: number | undefined, pageUrl: string) {
  if (tabId === undefined) return { ok: false };
  await withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = store[String(tabId)];
    if (entry?.urlKey === urlKey(pageUrl)) {
      entry.attempts = [];
      entry.actionAttempts = {};
      entry.pausedUntil = null;
      await setLoopStore(store);
    }
  });
  return { ok: true };
}
async function claimAutoMaximize(tabId: number | undefined, pageUrl: string) {
  if (tabId === undefined) return { claimed: false };
  return withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = store[String(tabId)];
    const claimed = !!entry?.pendingMaximizeAt && Date.now() - entry.pendingMaximizeAt < MAX_PENDING_AGE && entry.urlKey === urlKey(pageUrl);
    if (claimed && entry) { entry.pendingMaximizeAt = null; await setLoopStore(store); }
    return { claimed };
  });
}

async function manualRefresh(tabId: number, origin: string) {
  const settings = effectiveSettings(await loadSettings(), origin);
  if (settings.autoMaximize) {
    await withLoopLock(async () => {
      const store = await getLoopStore();
      let pageUrl = origin;
      try { pageUrl = (await apiCall<chrome.tabs.Tab>(ext.tabs.get, ext.tabs, tabId)).url ?? origin; } catch { /* origin */ }
      const entry = normalizedLoopEntry(store[String(tabId)], pageUrl);
      entry.pendingMaximizeAt = Date.now();
      store[String(tabId)] = entry;
      await setLoopStore(store);
    });
  }
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
}
async function resetTabAttempts(tabId: number) {
  await withLoopLock(async () => {
    const store = await getLoopStore();
    const entry = store[String(tabId)];
    if (entry) { entry.attempts = []; entry.actionAttempts = {}; entry.pausedUntil = null; await setLoopStore(store); }
  });
  await safeSendAll(tabId, { type: "RETRY_MONITORING" });
  return { ok: true };
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

async function getSessionSnapshots(): Promise<Record<string, PlayerSessionSnapshot>> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, SNAPSHOT_KEY);
  const snapshots = stored[SNAPSHOT_KEY] && typeof stored[SNAPSHOT_KEY] === "object" ? stored[SNAPSHOT_KEY] as Record<string, PlayerSessionSnapshot> : {};
  const now = Date.now();
  for (const [origin, snapshot] of Object.entries(snapshots)) if (snapshot.expiresAt <= now) delete snapshots[origin];
  return snapshots;
}
async function saveSessionSnapshot(snapshot: PlayerSessionSnapshot) {
  const area = ext.storage.session ?? ext.storage.local;
  const snapshots = await getSessionSnapshots(); snapshots[snapshot.origin] = snapshot;
  await apiCall<void>(area.set, area, { [SNAPSHOT_KEY]: snapshots }); return { ok: true };
}
async function clearSessionSnapshot(origin: string) {
  const area = ext.storage.session ?? ext.storage.local;
  const snapshots = await getSessionSnapshots(); delete snapshots[origin];
  await apiCall<void>(area.set, area, { [SNAPSHOT_KEY]: snapshots }); return { ok: true };
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
      await Promise.all(tabIds.map((id) => safeSendAll(id, { type: "SHUTDOWN_MONITOR" })));
      await unregisterAllManagedScripts();
      await revokeOptionalPermissions();
      for (const id of [...protectedTabs]) await updateDiscardProtection(id, false);
      runtimeTabs.clear();
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
    const area = ext.storage.session ?? ext.storage.local;
    await apiCall<void>(area.remove, area, [LOOP_KEY, STATUS_KEY, SNAPSHOT_KEY, SESSION_SEEN_KEY]);
    runtimeTabs.clear();
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
  let tabs: chrome.tabs.Tab[] = [];
  try { tabs = await apiCall(ext.tabs.query, ext.tabs, {}); } catch { return; }
  await Promise.all(tabs.map(async (tab) => {
    const origin = getOrigin(tab.url);
    if (tab.id !== undefined && origin) await safeSendAll(tab.id, { type: "SETTINGS_CHANGED", settings: effectiveSettings(settings, origin) });
  }));
}
async function safeSend(tabId: number, message: RuntimeMessage, frameId = 0) { try { await sendTabMessage(tabId, message, { frameId }); } catch { /* unavailable */ } }
async function safeSendAll(tabId: number, message: RuntimeMessage) { try { await sendTabMessage(tabId, message); } catch { /* unavailable */ } }

function selectBestStatus(tabId: number): FrameStatus | undefined {
  const values = [...(runtimeTabs.get(tabId)?.frames.values() ?? [])].filter((item) => Date.now() - item.updatedAt < 45_000);
  const priority: MonitorState[] = ["PAUSED_TOO_MANY_REFRESHES", "COUNTDOWN", "SUSPECTED_DOWN", "RECOVERING", "ERROR"];
  for (const state of priority) { const match = values.find((item) => item.state === state); if (match) return match; }
  return values.sort((a, b) => (b.hasVideo ? b.score : -1) - (a.hasVideo ? a.score : -1))[0];
}
function selectBestFrame(tabId: number): number {
  return [...(runtimeTabs.get(tabId)?.frames.entries() ?? [])]
    .filter(([, item]) => item.hasVideo && Date.now() - item.updatedAt < 45_000)
    .sort((a, b) => b[1].score - a[1].score)[0]?.[0] ?? 0;
}
function getTabState(tabId: number): TabRuntimeState {
  let state = runtimeTabs.get(tabId);
  if (!state) { state = { frames: new Map() }; runtimeTabs.set(tabId, state); }
  return state;
}
function defaultStatus(settings: Settings, origin: string | null): FrameStatus {
  const state: MonitorState = !settings.enabled ? "DISABLED" : !origin || !settings.perSite[origin]?.enabled ? "SITE_NOT_ENABLED" : "MONITORING";
  const detail = state === "DISABLED" ? "Extension is globally disabled" : state === "SITE_NOT_ENABLED" ? "Enable monitoring for this site" : "Waiting for a status update";
  return {
    state, detail, pageUrl: "", origin: origin ?? "", hasVideo: false, score: 0, confidence: 0, evidence: [], selectedVideoLabel: "",
    diagnosis: healthyDiagnosis(), streamKind: "UNKNOWN", liveIntent: "UNKNOWN_LIVE_POSITION", liveEdgeLagSeconds: null, bufferAheadSeconds: null,
    recoveryCycleId: null, circuitState: "CLOSED", compatibility: emptyCompatibility(), recoveryAction: null, nextActionAt: null,
    online: true, frameToken: "", updatedAt: Date.now()
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
    await safeSend(tab.id, { type: "STOP_COUNTDOWN", reason: "Countdown canceled by keyboard shortcut" });
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
async function getLoopStore(): Promise<LoopStore> {
  const area = ext.storage.session ?? ext.storage.local;
  const stored = await apiCall<Record<string, unknown>>(area.get, area, LOOP_KEY);
  return stored[LOOP_KEY] && typeof stored[LOOP_KEY] === "object" ? stored[LOOP_KEY] as LoopStore : {};
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

async function captureVisualSample(sender: chrome.runtime.MessageSender, rect: { x: number; y: number; width: number; height: number }) {
  if (sender.tab?.id === undefined || !sender.tab.active || rect.width <= 0 || rect.height <= 0) return { ok: false, error: "Visual sampling requires the active visible tab." };
  if (!await getVisualPrivacyAcknowledged()) return { ok: false, error: "Visual monitoring privacy acknowledgement is required." };
  try {
    const dataUrl = await apiCall<string>(ext.tabs.captureVisibleTab, ext.tabs, sender.tab.windowId, { format: "jpeg", quality: 45 });
    return { ok: true, dataUrl, rect };
  } catch { return { ok: false, error: "The browser did not allow a visual sample." }; }
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
async function removeTabState(tabId: number) {
  await withLoopLock(async () => { const store = await getLoopStore(); delete store[String(tabId)]; await setLoopStore(store); });
  const area = ext.storage.session ?? ext.storage.local;
  const statuses = await getStatusStore(); delete statuses[String(tabId)];
  await apiCall<void>(area.set, area, { [STATUS_KEY]: statuses });
}
