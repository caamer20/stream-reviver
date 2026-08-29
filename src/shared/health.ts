import type { HealthEvidence } from "./types";

export interface HealthSnapshot {
  explicitError: boolean;
  errorDetail?: string;
  withinGrace: boolean;
  online: boolean;
  hidden: boolean;
  paused: boolean;
  userPaused: boolean;
  ended: boolean;
  timeAdvanced: boolean;
  framesAdvanced: boolean | null;
  readyState: number;
  networkState: number;
  stalledForMs: number;
  frameStalledForMs: number;
  stallTimeoutMs: number;
  waitingEvents: number;
  liveEdgeLagSeconds: number | null;
  droppedFrameRatio: number | null;
}

export interface HealthAssessment {
  state: "healthy" | "monitoring" | "paused" | "offline" | "suspected";
  detail: string;
  confidence: number;
  evidence: HealthEvidence[];
}

export function assessVideoHealth(snapshot: HealthSnapshot): HealthAssessment {
  if (snapshot.withinGrace) return result("monitoring", "Waiting through the page-load grace period", 0, []);
  if (!snapshot.online) return result("offline", "Internet connection appears offline; recovery is paused", 0, []);
  if (snapshot.hidden) return result("monitoring", "Monitoring paused while this tab is hidden", 0, []);
  if (snapshot.explicitError) {
    const evidence = [{ signal: "media-error", detail: snapshot.errorDetail || "The player reported an error", weight: 100 }];
    return result("suspected", evidence[0].detail, 100, evidence);
  }
  if (snapshot.userPaused || (snapshot.paused && !snapshot.ended)) {
    return result("paused", "Video is paused; automatic recovery is suppressed", 0, []);
  }

  const evidence: HealthEvidence[] = [];
  if (snapshot.ended) evidence.push({ signal: "ended", detail: "The live video ended", weight: 90 });
  if (snapshot.stalledForMs >= snapshot.stallTimeoutMs) {
    evidence.push({ signal: "time-stalled", detail: "Playback time stopped advancing", weight: 45 });
  }
  if (snapshot.readyState < 2 && snapshot.stalledForMs >= snapshot.stallTimeoutMs * 0.6) {
    evidence.push({ signal: "not-ready", detail: "The player has insufficient media data", weight: 25 });
  }
  if (snapshot.networkState === 3) {
    evidence.push({ signal: "no-source", detail: "The player reports no usable media source", weight: 70 });
  }
  if (snapshot.waitingEvents >= 2) {
    evidence.push({ signal: "repeated-waiting", detail: `${snapshot.waitingEvents} waiting or stalled events observed`, weight: 15 });
  }
  if (snapshot.framesAdvanced === false && snapshot.frameStalledForMs >= snapshot.stallTimeoutMs) {
    evidence.push({ signal: "frames-frozen", detail: "The video is not presenting new frames", weight: snapshot.timeAdvanced ? 70 : 25 });
  }
  if (snapshot.liveEdgeLagSeconds !== null && snapshot.liveEdgeLagSeconds > 30) {
    evidence.push({ signal: "behind-live", detail: `Playback is ${Math.round(snapshot.liveEdgeLagSeconds)} seconds behind the live edge`, weight: 20 });
  }
  if (snapshot.droppedFrameRatio !== null && snapshot.droppedFrameRatio > 0.35) {
    evidence.push({ signal: "dropped-frames", detail: "An unusually high share of video frames are being dropped", weight: 15 });
  }

  const confidence = Math.min(100, evidence.reduce((total, item) => total + item.weight, 0));
  if (snapshot.timeAdvanced && snapshot.framesAdvanced !== false && confidence < 40) {
    return result("healthy", "Playback and presented frames are advancing", Math.max(0, confidence - 20), evidence);
  }
  if (confidence >= 65) return result("suspected", evidence[0]?.detail ?? "Multiple failure signals are present", confidence, evidence);
  return result("monitoring", evidence[0]?.detail ?? "Watching playback for sustained problems", confidence, evidence);
}

function result(state: HealthAssessment["state"], detail: string, confidence: number, evidence: HealthEvidence[]): HealthAssessment {
  return { state, detail, confidence, evidence };
}
