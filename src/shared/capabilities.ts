import type { PlayerType, ProtocolObservation } from "./types";

export interface MediaCapabilityProbe {
  declaredPlayerType: PlayerType;
  protocolKind: ProtocolObservation["kind"] | null;
  hasVideo: boolean;
  hasCanvasTarget: boolean;
  hasSrcObject: boolean;
  currentSource: string;
}

export interface MediaReloadDecision {
  safe: boolean;
  reason: string;
}

export function inferPlayerType(probe: MediaCapabilityProbe): PlayerType {
  if (probe.declaredPlayerType !== "AUTO") return probe.declaredPlayerType;
  if (probe.protocolKind) return probe.protocolKind;
  if (probe.hasSrcObject) return "WEBRTC";
  if (probe.hasVideo) return "HTML5";
  if (probe.hasCanvasTarget) return "CANVAS";
  return "AUTO";
}

export function decideMediaReload(type: PlayerType, probe: Pick<MediaCapabilityProbe, "hasVideo" | "hasSrcObject" | "currentSource">): MediaReloadDecision {
  if (!probe.hasVideo) return denied("No selected HTML media element is available");
  if (probe.hasSrcObject || type === "WEBRTC") return denied("MediaStream and WebRTC players do not expose a reloadable URL");
  if (type === "CANVAS") return denied("Canvas players do not expose a reloadable media element");
  if (type === "MSE" || type === "HLS_JS" || type === "DASH_JS") {
    return denied("JavaScript-managed media sources require an adapter-specific retry instead of video.load()");
  }
  if (type === "AUTO") return denied("Player type is not known well enough to reload safely");
  const scheme = sourceScheme(probe.currentSource);
  if (scheme === "blob" || scheme === "mediastream") return denied("Blob-backed media may be managed by MediaSource or application code");
  if (!probe.currentSource) return denied("The selected media element has no stable current source");
  return { safe: true, reason: "The selected native HTML media source can be reloaded" };
}

export function stableSourceFingerprint(source: string): string {
  if (!source) return "no-source";
  try {
    const parsed = new URL(source, "https://stream-reviver.invalid/");
    const path = parsed.pathname.replace(/\/{2,}/g, "/").slice(0, 500);
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return source.split(/[?#]/, 1)[0].slice(0, 500) || "invalid-source";
  }
}

function sourceScheme(source: string): string {
  const match = /^([a-z][a-z\d+.-]*):/i.exec(source.trim());
  return match?.[1].toLowerCase() ?? "relative";
}

function denied(reason: string): MediaReloadDecision { return { safe: false, reason }; }
