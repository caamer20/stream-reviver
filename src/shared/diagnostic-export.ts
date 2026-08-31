import type { HistoryEvent, Settings, SiteSettings } from "./types";

export interface DiagnosticRedactionOptions {
  includeOrigins: boolean;
  includeUrlPaths: boolean;
  includeSelectors: boolean;
  includeBrowserDetails: boolean;
}

export interface DiagnosticExportInput {
  exportedAt: string;
  extensionVersion: string;
  browserDetails?: string;
  settings: Settings;
  history: HistoryEvent[];
}

const selectorKeys = new Set([
  "selectedVideoSelector", "videoContainerSelector", "fullscreenButtonSelector", "playButtonSelector",
  "retryButtonSelector", "liveButtonSelector", "errorSelector", "accessInterruptionSelector", "adIndicatorSelector"
]);
const urlListKeys = new Set(["backupUrls", "includeUrlPatterns", "excludeUrlPatterns"]);
const safeMetadataKeys = new Set([
  "action", "failureKind", "recoveryCycleId", "circuitState", "confidence", "score", "success", "durationMs",
  "streamKind", "liveIntent", "playerType", "attempt", "attempts", "limit", "reasonCode"
]);

export function createDiagnosticExport(input: DiagnosticExportInput, options: DiagnosticRedactionOptions): Record<string, unknown> {
  const origins = collectOrigins(input.settings, input.history);
  const aliases = new Map(origins.map((origin, index) => [origin, `site-${index + 1}`]));
  const { perSite, ...globalSettings } = input.settings;
  const redactedSites: Record<string, unknown> = {};
  for (const [origin, site] of Object.entries(perSite)) {
    const key = options.includeOrigins ? origin : aliases.get(origin) ?? "site-unknown";
    redactedSites[key] = redactSite(site, options, aliases);
  }
  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt,
    extensionVersion: input.extensionVersion,
    browserDetails: options.includeBrowserDetails ? input.browserDetails ?? "unavailable" : "redacted",
    redaction: {
      origins: !options.includeOrigins,
      urlPaths: !options.includeUrlPaths,
      selectors: !options.includeSelectors,
      browserDetails: !options.includeBrowserDetails,
      streamContentIncluded: false
    },
    settings: { ...globalSettings, perSite: redactedSites },
    history: input.history.map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      level: event.level,
      event: event.event,
      detail: redactFreeText(event.detail, options),
      page: redactUrl(event.url, options, aliases),
      frameId: event.frameId,
      metadata: redactMetadata(event.metadata)
    }))
  };
}

function collectOrigins(settings: Settings, history: HistoryEvent[]): string[] {
  const origins = new Set(Object.keys(settings.perSite));
  for (const item of history) {
    try { origins.add(new URL(item.url).origin); } catch { /* non-URL diagnostic value */ }
  }
  return [...origins].sort();
}

function redactSite(site: SiteSettings, options: DiagnosticRedactionOptions, aliases: Map<string, string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(site)) {
    if (selectorKeys.has(key)) {
      if (options.includeSelectors && typeof value === "string") output[key] = value;
      else if (value) output[key] = "[redacted-selector]";
      continue;
    }
    if (urlListKeys.has(key)) {
      if (Array.isArray(value)) output[key] = value.map((item) => redactUrl(String(item), options, aliases));
      continue;
    }
    if (key === "profileId") continue;
    output[key] = value;
  }
  return output;
}

function redactUrl(value: string, options: DiagnosticRedactionOptions, aliases: Map<string, string>): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const host = options.includeOrigins ? parsed.origin : aliases.get(parsed.origin) ?? "site-external";
    if (!options.includeUrlPaths) return host;
    return `${host}${parsed.pathname}`.slice(0, 1000);
  } catch {
    return options.includeUrlPaths ? value.split(/[?#]/, 1)[0].slice(0, 1000) : "[redacted-url-pattern]";
  }
}

function redactFreeText(value: string, options: DiagnosticRedactionOptions): string {
  const text = value.slice(0, 500);
  return text.replace(/https?:\/\/[^\s)\]}>,"']+/gi, (raw) => {
    if (!options.includeUrlPaths || !options.includeOrigins) return "[redacted-url]";
    try { const parsed = new URL(raw); return `${parsed.origin}${parsed.pathname}`; }
    catch { return "[redacted-url]"; }
  });
}

function redactMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!safeMetadataKeys.has(key)) continue;
    if (typeof value === "string") output[key] = value.slice(0, 120);
    else if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}
