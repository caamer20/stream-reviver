import { apiCall, ext, originPattern, sendMessage } from "../shared/api";
import { DEFAULT_SETTINGS, DISCLAIMER } from "../shared/defaults";
import { getDisclaimerAcknowledged, getSettings, normalizeSettings, setSettings } from "../shared/settings";
import { normalizeProfile, profileToSiteOverrides } from "../shared/profiles";
import type { GlobalSettings, HistoryEvent, RecoveryAction, RuntimeMessage, SelectorField, Settings, SiteProfile, SiteSettings } from "../shared/types";

const scalarFields: Array<{ key: keyof GlobalSettings; label: string; type: "checkbox" | "number" }> = [
  ["autoRefresh", "Automatic refresh", "checkbox"], ["autoMaximize", "Automatic maximize", "checkbox"],
  ["checkIntervalSeconds", "Check interval (seconds)", "number"], ["healthyCheckIntervalSeconds", "Healthy interval (seconds)", "number"],
  ["suspectCheckIntervalSeconds", "Suspect interval (seconds)", "number"], ["mutationDebounceMs", "DOM debounce (ms)", "number"],
  ["stallTimeoutSeconds", "Stall timeout (seconds)", "number"], ["pageLoadGraceSeconds", "Page-load grace (seconds)", "number"],
  ["refreshCountdownSeconds", "Refresh countdown (seconds)", "number"], ["maxAutoRefreshes", "Maximum page reloads", "number"],
  ["refreshWindowMinutes", "Reload window (minutes)", "number"], ["successResetSeconds", "Healthy reset (seconds)", "number"],
  ["failureConfidenceThreshold", "Failure confidence", "number"], ["failureConfirmationChecks", "Confirmation checks", "number"],
  ["onlyWhenTabVisible", "Only visible tabs", "checkbox"], ["waitWhileOffline", "Wait while offline", "checkbox"],
  ["lockPrimaryVideo", "Lock primary player", "checkbox"], ["detectFrozenFrames", "Detect frozen frames", "checkbox"],
  ["restorePlayerPreferences", "Restore player preferences", "checkbox"], ["useCssMaximizeFallback", "CSS maximize fallback", "checkbox"],
  ["attemptNativeFullscreenClick", "Try fullscreen controls", "checkbox"], ["enablePictureInPicture", "Picture-in-Picture", "checkbox"],
  ["showBadge", "Show icon badge", "checkbox"], ["showNotifications", "Browser notifications", "checkbox"],
  ["localHistoryEnabled", "Local history", "checkbox"], ["historyLimit", "History limit", "number"]
  , ["enableAdaptiveTuning", "Local adaptive tuning", "checkbox"], ["enableAdvancedPlayerBridge", "Advanced player bridge", "checkbox"]
  , ["enableVisualWatchdog", "Visual watchdog", "checkbox"], ["keepScreenAwake", "Keep screen awake", "checkbox"]
  , ["protectTabFromDiscard", "Protect tab from discard", "checkbox"], ["liveEdgeThresholdSeconds", "Live-edge threshold", "number"]
  , ["recoveryVerificationSeconds", "Action verification", "number"], ["maxRecoveryActionsPerCycle", "Actions per cycle", "number"]
  , ["visualSampleIntervalSeconds", "Visual sample interval", "number"]
].map(([key, label, type]) => ({ key: key as keyof GlobalSettings, label: String(label), type: type as "checkbox" | "number" }));

const recoveryActions: RecoveryAction[] = ["WAIT", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"];
const recoveryLabels: Record<RecoveryAction, string> = {
  WAIT: "Wait and recheck", USER_PROMPT: "Ask for a playback click", REDISCOVER: "Rediscover the player", PLAY: "Resume playback",
  LIVE_EDGE: "Seek to live edge", RETRY_BUTTON: "Configured retry button", MEDIA_RELOAD: "Reload media element",
  IFRAME_RELOAD: "Reload player iframe", PAGE_RELOAD: "Reload page", BACKUP_HANDOFF: "Offer configured backup"
};
const selectorFields: Array<{ key: SelectorField; label: string; placeholder: string }> = [
  { key: "selectedVideoSelector", label: "Primary video", placeholder: "video#main-player" },
  { key: "videoContainerSelector", label: "Video container", placeholder: ".player-container" },
  { key: "fullscreenButtonSelector", label: "Fullscreen button", placeholder: "button[aria-label='Fullscreen']" },
  { key: "playButtonSelector", label: "Play button", placeholder: "button[aria-label='Play']" },
  { key: "retryButtonSelector", label: "Retry button", placeholder: ".retry-stream" },
  { key: "liveButtonSelector", label: "Go-live button", placeholder: "button[aria-label='Go live']" },
  { key: "errorSelector", label: "Error indicator", placeholder: ".player-error" },
  { key: "accessInterruptionSelector", label: "Access interruption", placeholder: ".login-required" },
  { key: "adIndicatorSelector", label: "Advertisement indicator", placeholder: ".ad-playing" }
];

const globalKeys: Array<keyof GlobalSettings> = ["enabled", ...scalarFields.map((item) => item.key)];
const siteList = byId<HTMLSelectElement>("site-list");
const siteEditor = byId("site-editor");
const feedback = byId("feedback");
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let selectedOrigin: string | null = null;
let pendingImport: unknown = null;
let history: HistoryEvent[] = [];
let profiles: SiteProfile[] = [];
let reloading = false;
void initialize();

async function initialize(): Promise<void> {
  byId("disclaimer-text").textContent = DISCLAIMER;
  buildOverrideFields();
  buildRecoveryFields("global-recovery-actions", "global");
  buildRecoveryFields("site-recovery-actions", "site");
  buildSelectorFields();
  bindEvents();
  await reload();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

function bindEvents(): void {
  byId("save-global").addEventListener("click", () => void saveGlobal());
  byId("add-site").addEventListener("click", () => void addSite());
  byId("save-site").addEventListener("click", () => void saveSite());
  byId("remove-site").addEventListener("click", () => void removeSite());
  siteList.addEventListener("change", () => { selectedOrigin = siteList.value || null; renderSiteEditor(); });
  byId("export-settings").addEventListener("click", exportSettings);
  byId<HTMLInputElement>("import-file").addEventListener("change", readImportFile);
  byId("import-settings").addEventListener("click", () => void importSettings());
  byId("reset-settings").addEventListener("click", () => void resetSettings());
  byId("export-diagnostics").addEventListener("click", exportDiagnostics);
  byId("clear-diagnostics").addEventListener("click", () => void clearDiagnostics());
  byId("profile-from-site").addEventListener("click", profileFromSite);
  byId("save-profile").addEventListener("click", () => void saveProfile());
  byId("apply-profile").addEventListener("click", () => void applyProfile());
  byId("export-profile").addEventListener("click", exportProfile);
  byId("delete-profile").addEventListener("click", () => void deleteProfile());
  byId<HTMLSelectElement>("profile-list").addEventListener("change", renderSelectedProfile);
  byId("acknowledge").addEventListener("click", async () => {
    await sendMessage({ type: "ACKNOWLEDGE_DISCLAIMER" } satisfies RuntimeMessage);
    await renderAcknowledgement(); showFeedback("Disclaimer acknowledged.");
  });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.streamReviverSettings && !reloading) void reload();
  });
}

async function reload(): Promise<void> {
  reloading = true;
  try {
    settings = await getSettings();
    [history, profiles] = await Promise.all([
      sendMessage<HistoryEvent[]>({ type: "GET_HISTORY", limit: 500 } satisfies RuntimeMessage),
      sendMessage<SiteProfile[]>({ type: "GET_PROFILES" } satisfies RuntimeMessage)
    ]);
    renderGlobal(); renderSites(); renderProfiles(); renderDiagnostics(); await renderAcknowledgement();
  } finally { reloading = false; }
}

function renderGlobal(): void {
  for (const key of globalKeys) {
    const input = byId<HTMLInputElement>(String(key));
    if (input.type === "checkbox") input.checked = settings[key] as boolean; else input.value = String(settings[key]);
  }
  for (const action of recoveryActions) byId<HTMLInputElement>(`global-action-${action}`).checked = settings.recoveryStrategy.includes(action);
  byId<HTMLInputElement>("recoveryBackoffSeconds").value = settings.recoveryBackoffSeconds.join(", ");
}

function renderSites(): void {
  const origins = Object.keys(settings.perSite).sort();
  siteList.replaceChildren(...origins.map((origin) => {
    const option = document.createElement("option"); option.value = origin; option.textContent = `${settings.perSite[origin].enabled ? "●" : "○"} ${origin}`; return option;
  }));
  if (selectedOrigin && !settings.perSite[selectedOrigin]) selectedOrigin = null;
  if (!selectedOrigin && origins.length) selectedOrigin = origins[0];
  siteList.value = selectedOrigin ?? "";
  renderSiteEditor();
}

function renderSiteEditor(): void {
  siteEditor.hidden = !selectedOrigin;
  if (!selectedOrigin) return;
  const site = settings.perSite[selectedOrigin] ?? {};
  byId("site-origin").textContent = selectedOrigin;
  byId<HTMLInputElement>("site-enabled").checked = site.enabled === true;
  for (const item of scalarFields) {
    const override = byId<HTMLInputElement>(`override-${String(item.key)}`);
    const input = byId<HTMLInputElement>(`site-${String(item.key)}`);
    const present = site[item.key] !== undefined;
    override.checked = present; input.disabled = !present;
    if (item.type === "checkbox") input.checked = (site[item.key] ?? settings[item.key]) as boolean;
    else input.value = String(site[item.key] ?? settings[item.key]);
    override.closest(".override-row")?.classList.toggle("inactive", !present);
  }
  for (const item of selectorFields) byId<HTMLInputElement>(item.key).value = site[item.key] ?? "";
  byId<HTMLTextAreaElement>("includeUrlPatterns").value = (site.includeUrlPatterns ?? []).join("\n");
  byId<HTMLTextAreaElement>("excludeUrlPatterns").value = (site.excludeUrlPatterns ?? []).join("\n");
  byId<HTMLSelectElement>("declaredPlayerType").value = site.declaredPlayerType ?? "AUTO";
  byId<HTMLTextAreaElement>("backupUrls").value = (site.backupUrls ?? []).join("\n");
  const strategyOverride = site.recoveryStrategy !== undefined;
  byId<HTMLInputElement>("override-recoveryStrategy").checked = strategyOverride;
  for (const action of recoveryActions) {
    const input = byId<HTMLInputElement>(`site-action-${action}`);
    input.checked = (site.recoveryStrategy ?? settings.recoveryStrategy).includes(action);
    input.disabled = !strategyOverride;
  }
  const backoffOverride = site.recoveryBackoffSeconds !== undefined;
  byId<HTMLInputElement>("override-recoveryBackoffSeconds").checked = backoffOverride;
  const backoff = byId<HTMLInputElement>("site-recoveryBackoffSeconds");
  backoff.value = (site.recoveryBackoffSeconds ?? settings.recoveryBackoffSeconds).join(", ");
  backoff.disabled = !backoffOverride;
}

function buildOverrideFields(): void {
  const container = byId("site-overrides");
  for (const item of scalarFields) {
    const row = document.createElement("div"); row.className = "override-row";
    const override = document.createElement("input"); override.type = "checkbox"; override.id = `override-${String(item.key)}`; override.setAttribute("aria-label", `Override ${item.label}`);
    const label = document.createElement("label"); label.htmlFor = `site-${String(item.key)}`; label.textContent = item.label;
    const input = document.createElement("input"); input.id = `site-${String(item.key)}`; input.type = item.type; if (item.type === "number") input.step = "any";
    override.addEventListener("change", () => { input.disabled = !override.checked; row.classList.toggle("inactive", !override.checked); });
    label.append(input); row.append(override, label); container.append(row);
  }
  byId<HTMLInputElement>("override-recoveryStrategy").addEventListener("change", (event) => {
    for (const action of recoveryActions) byId<HTMLInputElement>(`site-action-${action}`).disabled = !(event.target as HTMLInputElement).checked;
  });
  byId<HTMLInputElement>("override-recoveryBackoffSeconds").addEventListener("change", (event) => {
    byId<HTMLInputElement>("site-recoveryBackoffSeconds").disabled = !(event.target as HTMLInputElement).checked;
  });
}

function buildRecoveryFields(containerId: string, prefix: "global" | "site"): void {
  const container = byId(containerId);
  for (const action of recoveryActions) {
    const label = document.createElement("label");
    const input = document.createElement("input"); input.type = "checkbox"; input.id = `${prefix}-action-${action}`;
    label.append(input, document.createTextNode(recoveryLabels[action])); container.append(label);
  }
}

function buildSelectorFields(): void {
  const container = byId("selector-fields");
  for (const item of selectorFields) {
    const row = document.createElement("div"); row.className = "selector-row";
    const label = document.createElement("label");
    const labelCopy = document.createElement("span");
    labelCopy.textContent = item.label;
    const hint = document.createElement("small");
    hint.textContent = "CSS selector; use the picker to generate it.";
    labelCopy.append(hint);
    label.append(labelCopy);
    const input = document.createElement("input"); input.id = item.key; input.type = "text"; input.placeholder = item.placeholder; label.append(input);
    const pick = document.createElement("button"); pick.type = "button"; pick.textContent = "Pick on page";
    pick.addEventListener("click", () => void startPicker(item.key));
    row.append(label, pick); container.append(row);
  }
}

async function saveGlobal(): Promise<void> {
  try {
    const proposed = { ...settings } as Settings;
    for (const key of globalKeys) {
      const input = byId<HTMLInputElement>(String(key)); (proposed as any)[key] = input.type === "checkbox" ? input.checked : Number(input.value);
    }
    proposed.recoveryStrategy = recoveryActions.filter((action) => byId<HTMLInputElement>(`global-action-${action}`).checked);
    if (!proposed.recoveryStrategy.length) throw new Error("Select at least one recovery action.");
    proposed.recoveryBackoffSeconds = parseNumbers(byId<HTMLInputElement>("recoveryBackoffSeconds").value);
    if (proposed.showNotifications && !settings.showNotifications) {
      proposed.showNotifications = await apiCall<boolean>(ext.permissions.request, ext.permissions, { permissions: ["notifications"] });
    }
    settings = await setSettings(proposed);
    if (!settings.showNotifications && !Object.values(settings.perSite).some((site) => site.showNotifications === true)) {
      await apiCall<boolean>(ext.permissions.remove, ext.permissions, { permissions: ["notifications"] }).catch(() => false);
    }
    renderGlobal(); showFeedback("Global defaults saved.");
  } catch (error) { showError(error); }
}

async function addSite(): Promise<void> {
  try {
    const input = byId<HTMLInputElement>("new-origin"); const origin = normalizeOriginInput(input.value);
    if (!origin) throw new Error("Enter an http:// or https:// origin, such as https://example.com.");
    settings.perSite[origin] ??= { enabled: false }; settings = await setSettings(settings); selectedOrigin = origin; input.value = ""; renderSites();
    showFeedback("Site added. Enable it when ready to grant access.");
  } catch (error) { showError(error); }
}

async function saveSite(): Promise<void> {
  if (!selectedOrigin) return;
  try {
    const enable = byId<HTMLInputElement>("site-enabled").checked;
    if (enable && !await getDisclaimerAcknowledged()) throw new Error("Acknowledge the disclaimer before enabling monitoring.");
    const wantsNotifications = byId<HTMLInputElement>("override-showNotifications").checked && byId<HTMLInputElement>("site-showNotifications").checked;
    if (enable || wantsNotifications) {
      const pattern = enable ? originPattern(selectedOrigin) : null;
      const request: chrome.permissions.Permissions = {};
      if (pattern) request.origins = [pattern]; if (wantsNotifications) request.permissions = ["notifications"];
      if (!await apiCall<boolean>(ext.permissions.request, ext.permissions, request)) throw new Error("Requested browser access was not granted.");
    }
    const result = await sendMessage<{ ok: boolean; error?: string }>({ type: "SET_SITE_ENABLED", origin: selectedOrigin, enabled: enable } satisfies RuntimeMessage);
    if (!result.ok) throw new Error(result.error || "Could not update site access.");
    const overrides: SiteSettings = { enabled: enable };
    for (const item of scalarFields) {
      if (!byId<HTMLInputElement>(`override-${String(item.key)}`).checked) continue;
      const input = byId<HTMLInputElement>(`site-${String(item.key)}`); (overrides as any)[item.key] = item.type === "checkbox" ? input.checked : Number(input.value);
    }
    for (const item of selectorFields) overrides[item.key] = byId<HTMLInputElement>(item.key).value.trim();
    overrides.includeUrlPatterns = splitLines(byId<HTMLTextAreaElement>("includeUrlPatterns").value);
    overrides.excludeUrlPatterns = splitLines(byId<HTMLTextAreaElement>("excludeUrlPatterns").value);
    overrides.declaredPlayerType = byId<HTMLSelectElement>("declaredPlayerType").value as SiteSettings["declaredPlayerType"];
    overrides.backupUrls = splitLines(byId<HTMLTextAreaElement>("backupUrls").value);
    if (byId<HTMLInputElement>("override-recoveryStrategy").checked) {
      overrides.recoveryStrategy = recoveryActions.filter((action) => byId<HTMLInputElement>(`site-action-${action}`).checked);
      if (!overrides.recoveryStrategy.length) throw new Error("Select at least one site recovery action.");
    }
    if (byId<HTMLInputElement>("override-recoveryBackoffSeconds").checked) overrides.recoveryBackoffSeconds = parseNumbers(byId<HTMLInputElement>("site-recoveryBackoffSeconds").value);
    await sendMessage({ type: "SET_SITE_OVERRIDES", origin: selectedOrigin, overrides, replace: true } satisfies RuntimeMessage);
    await reload(); showFeedback(enable ? "Site settings and access saved." : "Site settings saved; access is disabled.");
  } catch (error) { showError(error); }
}

async function startPicker(field: SelectorField): Promise<void> {
  if (!selectedOrigin) return;
  try {
    const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "START_SELECTOR_PICKER", origin: selectedOrigin, field } satisfies RuntimeMessage);
    if (!response.ok) throw new Error(response.error || "Could not start the picker.");
    showFeedback("Picker started. Switch to the open site tab and click the desired element; Escape cancels.");
  } catch (error) { showError(error); }
}

async function removeSite(): Promise<void> {
  if (!selectedOrigin || !confirm(`Remove ${selectedOrigin} and revoke its access?`)) return;
  try {
    await sendMessage({ type: "SET_SITE_ENABLED", origin: selectedOrigin, enabled: false } satisfies RuntimeMessage);
    settings = await getSettings(); delete settings.perSite[selectedOrigin]; settings = await setSettings(settings); selectedOrigin = null; renderSites(); showFeedback("Site removed and access revoked.");
  } catch (error) { showError(error); }
}

function exportSettings(): void { downloadJson(settings, `stream-reviver-settings-${dateStamp()}.json`); showFeedback("Settings exported."); }
async function readImportFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]; pendingImport = null; byId<HTMLButtonElement>("import-settings").disabled = true; if (!file) return;
  try { pendingImport = JSON.parse(await file.text()); byId<HTMLButtonElement>("import-settings").disabled = false; showFeedback("Import file ready."); }
  catch (error) { showError(new Error(`Invalid JSON file: ${String(error)}`)); }
}
async function importSettings(): Promise<void> {
  if (!pendingImport) return;
  try {
    for (const [origin, site] of Object.entries(settings.perSite)) if (site.enabled) await sendMessage({ type: "SET_SITE_ENABLED", origin, enabled: false } satisfies RuntimeMessage);
    const imported = normalizeSettings(pendingImport); for (const site of Object.values(imported.perSite)) site.enabled = false;
    settings = await setSettings(imported); selectedOrigin = null; pendingImport = null; byId<HTMLButtonElement>("import-settings").disabled = true; await reload();
    showFeedback("Settings imported. Re-enable each site to grant access.");
  } catch (error) { showError(error); }
}
async function resetSettings(): Promise<void> {
  if (!confirm("Reset settings, local history, and all configured site access?")) return;
  try {
    for (const [origin, site] of Object.entries(settings.perSite)) if (site.enabled) await sendMessage({ type: "SET_SITE_ENABLED", origin, enabled: false } satisfies RuntimeMessage);
    await sendMessage({ type: "CLEAR_HISTORY" } satisfies RuntimeMessage); settings = await setSettings(structuredClone(DEFAULT_SETTINGS)); selectedOrigin = null; await reload();
    showFeedback("Defaults restored, history cleared, and site access removed.");
  } catch (error) { showError(error); }
}

function renderDiagnostics(): void {
  const correct = history.filter((item) => item.event === "user-marked-correct").length;
  const falseAlarms = history.filter((item) => item.event === "user-marked-false-alarm").length;
  const reloads = history.filter((item) => item.event === "page-reload").length;
  let cycles = 0; let recovered = 0; let awaitingRecovery = false;
  for (const item of [...history].reverse()) {
    if (item.event === "recovery-step" && !awaitingRecovery) { cycles += 1; awaitingRecovery = true; }
    if (item.event === "status-healthy" && awaitingRecovery) { recovered += 1; awaitingRecovery = false; }
    if (item.event === "status-paused_too_many_refreshes") awaitingRecovery = false;
  }
  const markedTotal = correct + falseAlarms;
  const markedPrecision = markedTotal ? `${Math.round(correct / markedTotal * 100)}%` : "—";
  const recoveryRate = cycles ? `${Math.round(recovered / cycles * 100)}%` : "—";
  byId("diagnostic-stats").replaceChildren(...[[history.length, "Stored events"], [reloads, "Page reloads"], [recoveryRate, "Observed recovery"], [markedPrecision, "User-rated precision"], [correct, "Marked correct"], [falseAlarms, "False alarms"]].map(([value, label]) => {
    const card = document.createElement("div"); card.className = "stat";
    const count = document.createElement("strong"); count.textContent = String(value);
    const copy = document.createElement("small"); copy.textContent = String(label);
    card.append(count, copy); return card;
  }));
  byId<HTMLTableSectionElement>("diagnostic-history").replaceChildren(...history.slice(0, 200).map((item) => {
    const row = document.createElement("tr");
    for (const text of [new Date(item.timestamp).toLocaleString(), item.event, item.detail, item.url]) { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); }
    return row;
  }));
}
function exportDiagnostics(): void {
  downloadJson({ exportedAt: new Date().toISOString(), extensionVersion: ext.runtime.getManifest().version, userAgent: navigator.userAgent, settings, history }, `stream-reviver-diagnostics-${dateStamp()}.json`);
}

function renderProfiles(): void {
  const select = byId<HTMLSelectElement>("profile-list");
  const selected = select.value;
  const options = [new Option("New profile", ""), ...profiles.sort((a, b) => a.name.localeCompare(b.name)).map((profile) => new Option(`${profile.name} v${profile.version}`, profile.id))];
  select.replaceChildren(...options);
  select.value = profiles.some((profile) => profile.id === selected) ? selected : "";
  renderSelectedProfile();
}
function renderSelectedProfile(): void {
  const id = byId<HTMLSelectElement>("profile-list").value;
  const profile = profiles.find((item) => item.id === id);
  byId<HTMLTextAreaElement>("profile-json").value = profile ? JSON.stringify(profile, null, 2) : "";
}
function profileFromSite(): void {
  if (!selectedOrigin) { showError(new Error("Select a configured site first.")); return; }
  const site = settings.perSite[selectedOrigin] ?? {};
  const now = Date.now();
  const selectors = Object.fromEntries(selectorFields.map(({ key }) => [key, site[key] ?? ""]).filter(([, value]) => value));
  const profile: SiteProfile = {
    schemaVersion: 1, id: crypto.randomUUID(), name: `${new URL(selectedOrigin).host} profile`, version: 1,
    originPatterns: [`${selectedOrigin}/*`], urlPatterns: site.includeUrlPatterns ?? [], declaredPlayerType: site.declaredPlayerType ?? "AUTO",
    selectors, recoveryStrategy: site.recoveryStrategy ?? settings.recoveryStrategy, backupUrls: site.backupUrls ?? [], notes: "", createdAt: now, updatedAt: now
  };
  byId<HTMLSelectElement>("profile-list").value = "";
  byId<HTMLTextAreaElement>("profile-json").value = JSON.stringify(profile, null, 2);
  showFeedback("Profile draft built from the selected site. Review and save it.");
}
async function saveProfile(): Promise<void> {
  try {
    const profile = normalizeProfile(JSON.parse(byId<HTMLTextAreaElement>("profile-json").value));
    const result = await sendMessage<{ ok: boolean; profile: SiteProfile }>({ type: "SAVE_PROFILE", profile } satisfies RuntimeMessage);
    await reload(); byId<HTMLSelectElement>("profile-list").value = result.profile.id; renderSelectedProfile(); showFeedback("Profile validated and saved locally.");
  } catch (error) { showError(error); }
}
async function applyProfile(): Promise<void> {
  if (!selectedOrigin) { showError(new Error("Select a site first.")); return; }
  try {
    const profile = normalizeProfile(JSON.parse(byId<HTMLTextAreaElement>("profile-json").value));
    await sendMessage({ type: "SET_SITE_OVERRIDES", origin: selectedOrigin, overrides: profileToSiteOverrides(profile) } satisfies RuntimeMessage);
    await reload(); showFeedback("Profile applied. Existing site access was not changed.");
  } catch (error) { showError(error); }
}
function exportProfile(): void {
  try { const profile = normalizeProfile(JSON.parse(byId<HTMLTextAreaElement>("profile-json").value)); downloadJson(profile, `stream-reviver-profile-${profile.id}.json`); }
  catch (error) { showError(error); }
}
async function deleteProfile(): Promise<void> {
  const id = byId<HTMLSelectElement>("profile-list").value; if (!id || !confirm("Delete this local profile?")) return;
  await sendMessage({ type: "DELETE_PROFILE", profileId: id } satisfies RuntimeMessage); await reload(); showFeedback("Profile deleted.");
}
async function clearDiagnostics(): Promise<void> {
  if (!confirm("Clear all locally stored Stream Reviver diagnostic history?")) return;
  await sendMessage({ type: "CLEAR_HISTORY" } satisfies RuntimeMessage); history = []; renderDiagnostics(); showFeedback("Diagnostic history cleared.");
}

async function renderAcknowledgement(): Promise<void> {
  const acknowledged = await getDisclaimerAcknowledged(); byId("ack-state").textContent = acknowledged ? "✓ Disclaimer acknowledged" : "Acknowledgement is required before monitoring can be enabled."; byId<HTMLButtonElement>("acknowledge").hidden = acknowledged;
}
function parseNumbers(value: string): number[] {
  const values = value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item > 0);
  if (!values.length) throw new Error("Enter at least one positive backoff value."); return values;
}
function splitLines(value: string): string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function normalizeOriginInput(value: string): string | null {
  try { const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); return ["http:", "https:"].includes(url.protocol) ? url.origin : null; } catch { return null; }
}
function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
function dateStamp(): string { return new Date().toISOString().slice(0, 10); }
function showFeedback(message: string): void { feedback.textContent = message; window.setTimeout(() => { if (feedback.textContent === message) feedback.textContent = ""; }, 7000); }
function showError(error: unknown): void { feedback.textContent = error instanceof Error ? error.message : String(error); }
function byId<T extends HTMLElement = HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing element #${id}`); return element as T; }
