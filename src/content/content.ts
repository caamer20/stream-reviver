import { addAsyncMessageListener, getOrigin, sendMessage } from "../shared/api";
import { assessVideoHealth, type HealthAssessment } from "../shared/health";
import { diagnoseFailure, healthyDiagnosis } from "../shared/diagnosis";
import { ObservationWindow, readBufferAhead, readLiveEdge } from "../shared/observations";
import { actionRisk, planRecovery } from "../shared/policy";
import { isUrlEnabled } from "../shared/settings";
import type {
  CompatibilityReport,
  EffectiveSettings,
  FailureDiagnosis,
  FailureKind,
  FrameStatus,
  HealthEvidence,
  LocalSiteModel,
  MonitorState,
  PlayerPreferences,
  PlayerSessionSnapshot,
  ProtocolObservation,
  RecoveryAction,
  RuntimeMessage,
  SelectorField
} from "../shared/types";
import { VideoCandidateManager, describeVideo } from "./candidates";
import { FrameCoordinator } from "./frame-coordinator";
import { UiLayer } from "./ui";

declare global { interface Window { __streamReviverLoaded?: boolean } }

if (!window.__streamReviverLoaded) {
  window.__streamReviverLoaded = true;
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  const origin = getOrigin(location.href);
  if (!origin) return;
  try {
    const context = await sendMessage<{
      acknowledged: boolean;
      settings: EffectiveSettings;
      pendingAutoMaximize: boolean;
      preferences?: PlayerPreferences;
      snoozedUntil?: number | null;
      eventModeUntil?: number | null;
      siteModel?: LocalSiteModel | null;
      sessionSnapshot?: PlayerSessionSnapshot;
    }>({ type: "GET_CONTEXT", origin, pageUrl: location.href } satisfies RuntimeMessage);
    const monitor = new StreamMonitor(origin, context.settings, {
      pendingAutoMaximize: context.pendingAutoMaximize,
      preferences: context.preferences,
      snoozedUntil: context.snoozedUntil ?? null,
      eventModeUntil: context.eventModeUntil ?? null,
      siteModel: context.siteModel ?? null,
      sessionSnapshot: context.sessionSnapshot
    });
    const removeMessageListener = addAsyncMessageListener(async (message: RuntimeMessage) => {
      const response = await monitor.handleMessage(message);
      if (message.type === "SHUTDOWN_MONITOR") {
        removeMessageListener();
        window.__streamReviverLoaded = false;
      }
      return response;
    });
    if (context.acknowledged) monitor.start();
  } catch {
    // Permit an explicit reinjection to retry if the service worker was waking up.
    window.__streamReviverLoaded = false;
  }
}

class StreamMonitor {
  private settings: EffectiveSettings;
  private readonly ui = new UiLayer();
  private readonly frames = new FrameCoordinator();
  private candidates: VideoCandidateManager;
  private readonly observations = new ObservationWindow();
  private primary: HTMLVideoElement | null = null;
  private visualTarget: HTMLElement | null = null;
  private primaryScore = 0;
  private primaryLabel = "";
  private timerId: number | null = null;
  private checking = false;
  private checkQueued = false;
  private destroyed = false;
  private pageStartedAt = Date.now();
  private primarySelectedAt = Date.now();
  private lastCurrentTime = 0;
  private lastAdvancedAt = Date.now();
  private presentedFrames = 0;
  private lastPresentedFrames = 0;
  private lastFramePresentedAt = Date.now();
  private frameCallbackId: number | null = null;
  private lastTotalFrames = 0;
  private lastDroppedFrames = 0;
  private waitingEvents = 0;
  private explicitError = "";
  private consecutiveFailures = 0;
  private healthySince: number | null = null;
  private successReported = false;
  private recoveryIndex = 0;
  private nextActionAt: number | null = null;
  private currentRecoveryAction: RecoveryAction | null = null;
  private recoveryPlan: RecoveryAction[] = [];
  private recoveryCycleId: string | null = null;
  private recoveryFailureKind: FailureKind = "NONE";
  private circuitState: FrameStatus["circuitState"] = "CLOSED";
  private activeAction: { action: RecoveryAction; startedAt: number } | null = null;
  private recoveryStartedAt: number | null = null;
  private accumulatedRebufferMs = 0;
  private diagnosis: FailureDiagnosis = healthyDiagnosis();
  private streamKind: FrameStatus["streamKind"] = "UNKNOWN";
  private liveIntent: FrameStatus["liveIntent"] = "UNKNOWN_LIVE_POSITION";
  private currentBufferAhead: number | null = null;
  private currentLiveLag: number | null = null;
  private refreshRequested = false;
  private requestSuppressedUntil = 0;
  private pendingAutoMaximize: boolean;
  private maximizeAttempted = false;
  private snoozedUntil: number | null;
  private eventModeUntil: number | null;
  private readonly siteModel: LocalSiteModel | null;
  private sessionSnapshot?: PlayerSessionSnapshot;
  private lastUrl = location.href;
  private lastState: MonitorState = "MONITORING";
  private lastReportKey = "";
  private lastReportAt = 0;
  private recentInteraction = new WeakMap<HTMLVideoElement, number>();
  private lastUserInputAt = 0;
  private userPaused = false;
  private savedPreferences?: PlayerPreferences;
  private lastCheckAt = Date.now();
  private recentBackwardSeekUntil = 0;
  private protocolObservation: ProtocolObservation | null = null;
  private protocolWindowStartedAt = 0;
  private protocolMessagesInWindow = 0;
  private wakeLock: any = null;
  private lastVisualSampleAt = 0;
  private lastVisualHash = "";
  private repeatedVisualSamples = 0;
  private preferenceTimer: number | null = null;
  private cssMaximized: HTMLElement | null = null;
  private pickerField: SelectorField | null = null;
  private pickerTarget: HTMLElement | null = null;
  private videoCleanups: Array<() => void> = [];

  constructor(
    private readonly origin: string,
    settings: EffectiveSettings,
    context: {
      pendingAutoMaximize: boolean; preferences?: PlayerPreferences; snoozedUntil: number | null;
      eventModeUntil: number | null; siteModel: LocalSiteModel | null; sessionSnapshot?: PlayerSessionSnapshot
    }
  ) {
    this.settings = settings;
    this.pendingAutoMaximize = context.pendingAutoMaximize;
    this.savedPreferences = context.preferences;
    this.snoozedUntil = context.snoozedUntil;
    this.eventModeUntil = context.eventModeUntil;
    this.siteModel = context.siteModel;
    this.sessionSnapshot = context.sessionSnapshot;
    this.candidates = new VideoCandidateManager(() => void this.check(), settings.mutationDebounceMs);
  }

  start(): void {
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", () => this.start(), { once: true });
      return;
    }
    this.candidates.start();
    this.frames.start(() => void this.check());
    document.addEventListener("pointerdown", this.onUserInput, true);
    document.addEventListener("keydown", this.onUserInput, true);
    window.addEventListener("online", this.onNetworkChange);
    window.addEventListener("offline", this.onNetworkChange);
    window.addEventListener("message", this.onProtocolMessage);
    window.addEventListener("pagehide", this.onPageHide);
    void this.check();
  }

  async handleMessage(message: RuntimeMessage): Promise<unknown> {
    switch (message.type) {
      case "SHUTDOWN_MONITOR":
        this.destroy();
        return { ok: true };
      case "SETTINGS_CHANGED":
        this.settings = message.settings;
        this.candidates.updateDebounce(message.settings.mutationDebounceMs);
        this.resetRecovery();
        await this.check();
        return { ok: true };
      case "START_COUNTDOWN":
        if (window.top === window) this.startCountdown(message.seconds, message.reason);
        return { ok: true };
      case "EXTEND_COUNTDOWN_IN_PAGE":
        if (window.top === window) this.ui.extendCountdown(message.seconds);
        return { ok: true };
      case "STOP_COUNTDOWN":
        this.ui.hideCountdown();
        if (message.reason) this.ui.toast(message.reason, "success");
        return { ok: true };
      case "SHOW_LOOP_WARNING":
        this.ui.hideCountdown();
        this.ui.toast(message.detail, "warning", 0);
        await this.report("PAUSED_TOO_MANY_REFRESHES", message.detail, 100, [], true);
        return { ok: true };
      case "RETRY_MONITORING":
        this.resetRecovery();
        this.requestSuppressedUntil = 0;
        this.ui.toast("Recovery attempts reset.", "success");
        await this.check();
        return { ok: true };
      case "SNOOZE_UNTIL":
        this.snoozedUntil = message.until;
        this.ui.hideCountdown();
        await this.check();
        return { ok: true };
      case "EVENT_MODE_UNTIL":
        this.eventModeUntil = message.until;
        await this.check();
        return { ok: true };
      case "MAXIMIZE_NOW":
        await this.maximizePrimary(message.manual === true);
        return { ok: true };
      case "PICTURE_IN_PICTURE_NOW":
        await this.pictureInPicture();
        return { ok: true };
      case "JUMP_TO_LIVE_NOW":
        await this.performRecoveryAction("LIVE_EDGE", "Manual jump to live", 100);
        await this.check();
        return { ok: true };
      case "MAXIMIZE_IFRAME":
        if (window.top === window) await this.maximizeIframe();
        return { ok: true };
      case "RECOVER_IFRAME":
        if (window.top === window) {
          const recovered = this.frames.recoverIframe(message.frameToken);
          if (recovered) this.ui.toast("Reloaded the embedded player frame.", "info");
        }
        return { ok: true };
      case "BEGIN_ELEMENT_PICKER":
        this.beginPicker(message.field);
        return { ok: true };
      case "VALIDATE_SELECTOR":
        return this.validateSelector(message.field, message.selector);
      case "STOP_ELEMENT_PICKER":
        this.stopPicker();
        return { ok: true };
      default:
        return undefined;
    }
  }

  private async check(): Promise<void> {
    if (this.destroyed) return;
    if (this.checking) { this.checkQueued = true; return; }
    this.checking = true;
    try { await this.runCheck(); }
    finally {
      this.checking = false;
      this.scheduleNext();
      if (this.checkQueued) {
        this.checkQueued = false;
        queueMicrotask(() => void this.check());
      }
    }
  }

  private async runCheck(): Promise<void> {
    if (!this.settings.enabled || !this.settings.siteEnabled) {
      await this.report(this.settings.enabled ? "SITE_NOT_ENABLED" : "DISABLED",
        this.settings.enabled ? "Site monitoring is disabled" : "Extension is globally disabled", 0, []);
      return;
    }
    if (!isUrlEnabled(location.href, this.settings)) {
      await this.report("URL_EXCLUDED", "This page does not match the site’s URL rules", 0, []);
      return;
    }
    if (this.lastUrl !== location.href) {
      this.lastUrl = location.href;
      this.pageStartedAt = Date.now();
      this.resetPrimaryState();
      this.resetRecovery();
      await this.log("navigation", "Monitoring followed a single-page navigation", "info");
    }
    if (this.isSnoozed()) {
      const detail = this.snoozedUntil === -1 ? "Monitoring is paused for this tab" : `Monitoring snoozed until ${new Date(this.snoozedUntil!).toLocaleTimeString()}`;
      await this.report("SNOOZED", detail, 0, []);
      return;
    }
    if (this.settings.onlyWhenTabVisible && document.hidden) {
      await this.report("MONITORING", "Monitoring paused while this tab is hidden", 0, []);
      return;
    }
    if (this.settings.waitWhileOffline && !navigator.onLine) {
      this.resetRecovery(false);
      await this.report("OFFLINE", "Internet connection appears offline; attempts are preserved", 0, []);
      return;
    }
    const interruption = this.findAccessInterruption();

    const selection = this.candidates.select(this.primary, this.settings, this.recentInteraction, this.frames.getVisibilityFactor());
    if (selection.video !== this.primary) this.setPrimary(selection.video, selection.score, selection.label);
    else { this.primaryScore = selection.score; this.primaryLabel = selection.label; }

    const overlayError = this.findConfiguredError();
    if (!this.primary) {
      if (overlayError && !this.withinGracePeriod()) {
        this.diagnosis = {
          kind: "MEDIA_SOURCE_ERROR", alternatives: [], confidence: 100, severity: "critical", detail: overlayError,
          evidence: [{ signal: "configured-error", detail: overlayError, weight: 100 }], recoverySafe: true, requiresUser: false, observedAt: Date.now()
        };
        await this.processFailure(overlayError, 100, [{ signal: "configured-error", detail: overlayError, weight: 100 }]);
      } else if (this.settings.enableVisualWatchdog && (this.visualTarget = this.findVisualTarget())) {
        const visualProgress = await this.sampleVisualProgress(this.visualTarget);
        const frozen = visualProgress === false;
        this.diagnosis = frozen ? {
          kind: "UNKNOWN_FAILURE", alternatives: [], confidence: 45, severity: "warning",
          detail: "The non-HTML player image appears unchanged",
          evidence: [{ signal: "visual-freeze", detail: "Three privacy-preserving visual samples matched", weight: 45 }],
          recoverySafe: false, requiresUser: false, observedAt: Date.now()
        } : healthyDiagnosis();
        await this.report("LIMITED_VISIBILITY", frozen
          ? "A non-HTML player may be frozen; visual evidence alone will not trigger automatic recovery"
          : "Observing a non-HTML player visually; automatic recovery requires stronger evidence",
        this.diagnosis.confidence, this.diagnosis.evidence);
      } else {
        this.visualTarget = null;
        this.consecutiveFailures = 0;
        await this.report("NO_VIDEO_FOUND", "No visible HTML5 video found", 0, []);
      }
      return;
    }

    const now = Date.now();
    this.visualTarget = null;
    const lifecycleGapMs = now - this.lastCheckAt;
    this.lastCheckAt = now;
    const currentTime = finite(this.primary.currentTime);
    const timeAdvanced = Math.abs(currentTime - this.lastCurrentTime) >= 0.15;
    if (timeAdvanced) this.lastAdvancedAt = now;
    this.lastCurrentTime = currentTime;
    const frameApiAvailable = typeof (this.primary as any).requestVideoFrameCallback === "function";
    let framesAdvanced = this.settings.detectFrozenFrames && frameApiAvailable
      ? this.presentedFrames > this.lastPresentedFrames
      : null;
    if (framesAdvanced === null && this.settings.enableVisualWatchdog) {
      const visual = await this.sampleVisualProgress();
      if (visual !== null) framesAdvanced = visual;
    }
    this.lastPresentedFrames = this.presentedFrames;
    const quality = this.readPlaybackQuality();
    const explicitError = overlayError || this.explicitError || (this.primary.error
      ? `Media error${this.primary.error.code ? ` (code ${this.primary.error.code})` : ""}` : "");
    this.currentBufferAhead = readBufferAhead(this.primary);
    const edge = readLiveEdge(this.primary);
    this.currentLiveLag = edge === null ? null : Math.max(0, edge - currentTime);
    const trends = this.observations.push({
      timestamp: now, currentTime, duration: this.primary.duration, paused: this.primary.paused, ended: this.primary.ended,
      readyState: this.primary.readyState, networkState: this.primary.networkState, timeAdvanced, framesAdvanced,
      presentedFrames: this.presentedFrames, droppedFrameRatio: quality, bufferAheadSeconds: this.currentBufferAhead,
      liveEdge: edge, liveEdgeLagSeconds: this.currentLiveLag, waitingEvents: this.waitingEvents, explicitError,
      online: navigator.onLine, hidden: document.hidden, userPaused: this.userPaused,
      recentBackwardSeek: Date.now() < this.recentBackwardSeekUntil, accessInterruption: interruption,
      adTransition: this.isAdTransition(), lifecycleGapMs, protocol: this.protocolObservation
    });
    this.streamKind = trends.streamKind;
    this.liveIntent = trends.liveIntent;
    this.diagnosis = this.withinGracePeriod()
      ? { kind: "STARTUP_DELAY", alternatives: [], confidence: 0, severity: "info", detail: "Waiting through the page-load grace period", evidence: [], recoverySafe: false, requiresUser: false, observedAt: now }
      : diagnoseFailure(this.observations.latest()!, trends, this.settings);
    let legacyAssessment = assessVideoHealth({
      explicitError: !!explicitError,
      errorDetail: explicitError,
      withinGrace: this.withinGracePeriod(),
      online: navigator.onLine,
      hidden: this.settings.onlyWhenTabVisible && document.hidden,
      paused: this.primary.paused,
      userPaused: this.userPaused,
      ended: this.primary.ended,
      timeAdvanced,
      framesAdvanced,
      readyState: this.primary.readyState,
      networkState: this.primary.networkState,
      stalledForMs: now - this.lastAdvancedAt,
      frameStalledForMs: now - this.lastFramePresentedAt,
      stallTimeoutMs: this.settings.stallTimeoutSeconds * 1000,
      waitingEvents: this.waitingEvents,
      liveEdgeLagSeconds: this.currentLiveLag,
      droppedFrameRatio: quality
    });
    if (this.primary.ended && this.streamKind === "VOD" && !explicitError) {
      legacyAssessment = { state: "monitoring", detail: "Finite video ended normally", confidence: 0, evidence: [] };
    }
    if (this.diagnosis.kind === "NONE" && legacyAssessment.state === "suspected") {
      this.diagnosis = {
        kind: "UNKNOWN_FAILURE", alternatives: [], confidence: legacyAssessment.confidence, severity: "warning",
        detail: legacyAssessment.detail, evidence: legacyAssessment.evidence, recoverySafe: true, requiresUser: false, observedAt: now
      };
    }
    const assessment = this.assessmentFromDiagnosis(this.diagnosis, legacyAssessment);
    await this.handleAssessment(assessment);
    await this.updateWakeLock(assessment.state === "healthy");

    if (this.pendingAutoMaximize && !this.maximizeAttempted) {
      this.maximizeAttempted = true;
      const response = await sendMessage<{ claimed: boolean }>({ type: "CLAIM_AUTO_MAXIMIZE", pageUrl: location.href } satisfies RuntimeMessage)
        .catch(() => ({ claimed: false }));
      if (response.claimed) await this.maximizePrimary(false);
      this.pendingAutoMaximize = false;
    }
  }

  private async handleAssessment(assessment: HealthAssessment): Promise<void> {
    if (assessment.state === "healthy") {
      const now = Date.now();
      if (this.healthySince === null) this.healthySince = now;
      if (this.activeAction && now - this.healthySince < this.settings.recoveryVerificationSeconds * 1000) {
        this.circuitState = "VERIFYING";
        const remaining = Math.ceil((this.settings.recoveryVerificationSeconds * 1000 - (now - this.healthySince)) / 1000);
        await this.report("RECOVERING", `${recoveryLabel(this.activeAction.action)} appears successful; verifying for ${remaining}s`, 0, []);
        return;
      }
      this.explicitError = "";
      this.waitingEvents = 0;
      this.consecutiveFailures = 0;
      this.refreshRequested = false;
      if (this.activeAction) {
        if (this.recoveryStartedAt !== null) this.accumulatedRebufferMs += Math.max(0, now - this.recoveryStartedAt);
        await this.recordActionOutcome(this.activeAction.action, true, now - this.activeAction.startedAt);
        await this.log("recovery-verified", `${recoveryLabel(this.activeAction.action)} restored sustained playback`, "success", { action: this.activeAction.action, recoveryCycleId: this.recoveryCycleId, failureKind: this.recoveryFailureKind });
      }
      this.resetRecovery(false);
      this.diagnosis = healthyDiagnosis(now);
      await this.report("HEALTHY", assessment.detail, assessment.confidence, assessment.evidence);
      if (!this.successReported && now - this.healthySince >= this.settings.successResetSeconds * 1000) {
        this.successReported = true;
        await sendMessage({ type: "PLAYBACK_SUCCESS", pageUrl: location.href } satisfies RuntimeMessage).catch(() => undefined);
        await sendMessage({
          type: "RECORD_HEALTH_SAMPLE", origin: this.origin,
          sample: { startupMs: Math.max(0, now - this.pageStartedAt), rebufferMs: this.accumulatedRebufferMs, liveLagSeconds: this.currentLiveLag, timestamp: now }
        } satisfies RuntimeMessage).catch(() => undefined);
        await sendMessage({ type: "CLEAR_SESSION_SNAPSHOT", origin: this.origin } satisfies RuntimeMessage).catch(() => undefined);
        await this.log("attempts-reset", "Sustained healthy playback cleared recovery history", "success");
      }
      return;
    }
    // A polling instant can land exactly on a media loop boundary or between
    // frame callbacks. During post-action verification, treat that single
    // inconclusive sample as continuity only when the player is ready and has
    // advanced recently. High-confidence failures still break verification.
    if (this.activeAction && assessment.state === "monitoring" &&
      assessment.confidence < this.settings.failureConfidenceThreshold && this.primary && !this.primary.paused &&
      this.primary.readyState >= 2 && Date.now() - this.lastAdvancedAt < this.settings.stallTimeoutSeconds * 1000) {
      await this.handleAssessment({ state: "healthy", detail: "Playback remains responsive during recovery verification", confidence: 0, evidence: assessment.evidence });
      return;
    }
    this.healthySince = null;
    if (assessment.state === "offline") {
      await this.report("OFFLINE", assessment.detail, 0, assessment.evidence);
      return;
    }
    if (assessment.state === "paused") {
      this.consecutiveFailures = 0;
      await this.report("MONITORING", assessment.detail, 0, assessment.evidence);
      return;
    }
    if (assessment.confidence >= this.settings.failureConfidenceThreshold) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.settings.failureConfirmationChecks) {
        await this.processFailure(assessment.detail, assessment.confidence, assessment.evidence);
        return;
      }
      await this.report("MONITORING",
        `${assessment.detail}; confirming (${this.consecutiveFailures}/${this.settings.failureConfirmationChecks})`,
        assessment.confidence, assessment.evidence);
      return;
    }
    this.consecutiveFailures = 0;
    await this.report("MONITORING", assessment.detail, assessment.confidence, assessment.evidence);
  }

  private async processFailure(detail: string, confidence: number, evidence: HealthEvidence[]): Promise<void> {
    if (!this.settings.autoRefresh) {
      await this.report("SUSPECTED_DOWN", `${detail}; automatic recovery is disabled`, confidence, evidence, true);
      return;
    }
    if (Date.now() < this.requestSuppressedUntil) {
      await this.report("SUSPECTED_DOWN", `${detail}; recovery was recently canceled`, confidence, evidence);
      return;
    }
    if (this.nextActionAt && Date.now() < this.nextActionAt) {
      this.circuitState = "OPEN_COOLDOWN";
      await this.report("RECOVERING", `${detail}; next recovery step in ${Math.ceil((this.nextActionAt - Date.now()) / 1000)}s`,
        confidence, evidence);
      return;
    }
    if (this.circuitState === "OPEN_COOLDOWN") this.circuitState = "HALF_OPEN";

    if (!this.recoveryCycleId) {
      this.recoveryCycleId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      this.recoveryFailureKind = this.diagnosis.kind;
      this.recoveryPlan = planRecovery(this.diagnosis.kind, this.settings, this.siteModel);
      this.recoveryIndex = 0;
      this.recoveryStartedAt = Date.now();
      await this.log("recovery-cycle-started", `${this.diagnosis.kind}: ${detail}`, "warning", { recoveryCycleId: this.recoveryCycleId, diagnosis: this.diagnosis });
    }
    if (this.activeAction) {
      this.circuitState = "HALF_OPEN";
      await this.recordActionOutcome(this.activeAction.action, false, Date.now() - this.activeAction.startedAt);
      await this.log("recovery-verification-failed", `${recoveryLabel(this.activeAction.action)} did not restore playback`, "warning", { action: this.activeAction.action, recoveryCycleId: this.recoveryCycleId });
      this.activeAction = null;
    }
    const action = this.recoveryPlan[this.recoveryIndex];
    if (!action) {
      this.circuitState = "OPEN_REQUIRES_USER";
      await this.report("PAUSED_TOO_MANY_REFRESHES", `${detail}; all safe recovery actions were exhausted`, confidence, evidence, true);
      this.ui.toast("Automatic recovery paused after exhausting the configured actions.", "warning", 0);
      return;
    }
    this.currentRecoveryAction = action;
    await this.report(action === "PAGE_RELOAD" ? "SUSPECTED_DOWN" : "RECOVERING",
      `${detail}; recovery step: ${recoveryLabel(action)}`, confidence, evidence, true);
    await this.log("recovery-step", `Running ${recoveryLabel(action)}`, "warning", { action, confidence, evidence, recoveryCycleId: this.recoveryCycleId, failureKind: this.recoveryFailureKind, risk: actionRisk(action) });
    const initiated = await this.performRecoveryAction(action, detail, confidence);
    this.recoveryIndex += 1;
    if (initiated) { this.activeAction = { action, startedAt: Date.now() }; this.circuitState = "VERIFYING"; }
    else await this.recordActionOutcome(action, false, 0);
    if (action !== "PAGE_RELOAD" || !initiated) {
      const backoff = this.settings.recoveryBackoffSeconds[Math.min(this.recoveryIndex - 1, this.settings.recoveryBackoffSeconds.length - 1)] ?? 15;
      this.nextActionAt = Date.now() + jitter(Math.max(backoff, this.settings.recoveryVerificationSeconds) * 1000);
      if (!initiated) this.circuitState = "OPEN_COOLDOWN";
    }
  }

  private async performRecoveryAction(action: RecoveryAction, detail: string, confidence: number): Promise<boolean> {
    switch (action) {
      case "WAIT":
        return true;
      case "USER_PROMPT":
        this.ui.prompt("Click to resume stream", () => void this.primary?.play().catch(() => undefined));
        return true;
      case "REDISCOVER": {
        const selection = this.candidates.select(null, this.settings, this.recentInteraction, this.frames.getVisibilityFactor());
        if (!selection.video) return false;
        if (selection.video !== this.primary) this.setPrimary(selection.video, selection.score, selection.label);
        return true;
      }
      case "PLAY":
        if (!this.primary || this.userPaused) return false;
        try {
          const playButton = this.safeConfiguredControl(this.settings.playButtonSelector);
          if (playButton) playButton.click();
          await this.primary.play();
          return true;
        } catch { return false; }
      case "LIVE_EDGE": {
        if (!this.primary?.seekable.length) return false;
        const liveButton = this.safeConfiguredControl(this.settings.liveButtonSelector);
        if (liveButton) liveButton.click();
        const edge = this.primary.seekable.end(this.primary.seekable.length - 1);
        if (!Number.isFinite(edge) || edge - this.primary.currentTime < 3) return false;
        this.primary.currentTime = Math.max(0, edge - 0.5);
        return true;
      }
      case "RETRY_BUTTON": {
        const retry = this.safeConfiguredControl(this.settings.retryButtonSelector);
        if (!retry) return false;
        retry.click();
        return true;
      }
      case "MEDIA_RELOAD":
        if (!this.primary || this.userPaused) return false;
        await this.captureSessionSnapshot();
        try { this.primary.load(); await this.primary.play(); return true; } catch { return false; }
      case "IFRAME_RELOAD":
        if (window.top === window) return false;
        await sendMessage({ type: "REQUEST_IFRAME_RECOVERY", frameToken: this.frames.token } satisfies RuntimeMessage).catch(() => undefined);
        return true;
      case "PAGE_RELOAD":
        if (this.refreshRequested) return true;
        await this.captureSessionSnapshot();
        this.refreshRequested = true;
        const result = await sendMessage<{ ok: boolean; error?: string }>({
          type: "REQUEST_AUTO_REFRESH", origin: this.origin, pageUrl: location.href, reason: detail, confidence
        } satisfies RuntimeMessage).catch((error) => ({ ok: false, error: String(error) }));
        if (!result.ok) {
          this.refreshRequested = false;
          if (result.error && !result.error.includes("disabled")) this.ui.toast(result.error, "warning", 8000);
        }
        return result.ok;
      case "BACKUP_HANDOFF": {
        const backup = this.settings.backupUrls[0];
        if (!backup) return false;
        this.ui.prompt("Open configured backup stream", () => location.assign(backup));
        return true;
      }
    }
  }

  private setPrimary(video: HTMLVideoElement | null, score: number, label: string): void {
    const preserveRecoveryCycle = this.recoveryCycleId !== null;
    this.detachPrimary();
    this.primary = video;
    this.primaryScore = score;
    this.primaryLabel = label;
    this.resetPrimaryState();
    if (!preserveRecoveryCycle) this.resetRecovery();
    if (!video) return;
    const onError = () => { this.explicitError = "The video element emitted an error"; void this.check(); };
    const onWaiting = () => { if (!video.paused) this.waitingEvents += 1; void this.check(); };
    const onPlaying = () => { this.userPaused = false; this.explicitError = ""; this.lastAdvancedAt = Date.now(); void this.check(); };
    const onPause = () => { if (Date.now() - this.lastUserInputAt < 1800) this.userPaused = true; void this.check(); };
    const onSeeking = () => {
      if (Date.now() - this.lastUserInputAt < 1800 && video.currentTime < this.lastCurrentTime - 2) this.recentBackwardSeekUntil = Date.now() + 120_000;
    };
    const onPreference = () => this.schedulePreferenceSave();
    for (const event of ["error", "waiting", "stalled", "playing", "canplay", "pause", "seeking", "volumechange", "ratechange"] as const) {
      const listener = event === "error" ? onError : event === "waiting" || event === "stalled" ? onWaiting
        : event === "playing" || event === "canplay" ? onPlaying : event === "pause" ? onPause : event === "seeking" ? onSeeking : onPreference;
      video.addEventListener(event, listener);
      this.videoCleanups.push(() => video.removeEventListener(event, listener));
    }
    this.startFrameCallbacks(video);
    if (this.settings.restorePlayerPreferences && this.savedPreferences) this.applyPreferences(video, this.savedPreferences);
    if (this.sessionSnapshot && this.sessionSnapshot.expiresAt > Date.now()) void this.restoreSessionSnapshot(video, this.sessionSnapshot);
    void this.log("player-selected", `${describeVideo(video, !!this.settings.selectedVideoSelector)} selected`, "info", { score });
  }

  private detachPrimary(): void {
    for (const cleanup of this.videoCleanups.splice(0)) cleanup();
    if (this.primary && this.frameCallbackId !== null && typeof (this.primary as any).cancelVideoFrameCallback === "function") {
      try { (this.primary as any).cancelVideoFrameCallback(this.frameCallbackId); } catch { /* detached */ }
    }
    this.frameCallbackId = null;
  }

  private startFrameCallbacks(video: HTMLVideoElement): void {
    if (!this.settings.detectFrozenFrames || typeof (video as any).requestVideoFrameCallback !== "function") return;
    const callback = (_now: number, metadata: { presentedFrames?: number }) => {
      if (this.primary !== video || this.destroyed) return;
      this.presentedFrames = metadata.presentedFrames ?? this.presentedFrames + 1;
      this.lastFramePresentedAt = Date.now();
      this.frameCallbackId = (video as any).requestVideoFrameCallback(callback);
    };
    this.frameCallbackId = (video as any).requestVideoFrameCallback(callback);
  }

  private resetPrimaryState(): void {
    this.primarySelectedAt = Date.now();
    this.lastAdvancedAt = Date.now();
    this.lastFramePresentedAt = Date.now();
    this.lastCurrentTime = this.primary ? finite(this.primary.currentTime) : 0;
    this.presentedFrames = this.lastPresentedFrames = 0;
    this.lastTotalFrames = this.lastDroppedFrames = 0;
    this.waitingEvents = 0;
    this.explicitError = "";
    this.userPaused = false;
    this.healthySince = null;
    this.successReported = false;
    this.consecutiveFailures = 0;
    this.observations.clear();
  }

  private resetRecovery(clearRefresh = true): void {
    this.recoveryIndex = 0;
    this.nextActionAt = null;
    this.currentRecoveryAction = null;
    this.recoveryPlan = [];
    this.recoveryCycleId = null;
    this.recoveryFailureKind = "NONE";
    this.circuitState = "CLOSED";
    this.activeAction = null;
    this.recoveryStartedAt = null;
    if (clearRefresh) this.refreshRequested = false;
  }

  private readPlaybackQuality(): number | null {
    if (!this.primary || typeof this.primary.getVideoPlaybackQuality !== "function") return null;
    const quality = this.primary.getVideoPlaybackQuality();
    const totalDelta = quality.totalVideoFrames - this.lastTotalFrames;
    const droppedDelta = quality.droppedVideoFrames - this.lastDroppedFrames;
    this.lastTotalFrames = quality.totalVideoFrames;
    this.lastDroppedFrames = quality.droppedVideoFrames;
    return totalDelta > 10 ? droppedDelta / totalDelta : null;
  }

  private withinGracePeriod(): boolean {
    return Date.now() - this.pageStartedAt < this.settings.pageLoadGraceSeconds * 1000 ||
      Date.now() - this.primarySelectedAt < Math.min(5, this.settings.pageLoadGraceSeconds) * 1000;
  }

  private findConfiguredError(): string {
    const element = this.queryConfigured(this.settings.errorSelector);
    if (!element || !isVisible(element)) return "";
    const copy = element.textContent?.trim().slice(0, 120);
    return `Configured error indicator is visible${copy ? `: ${copy}` : ""}`;
  }

  private findAccessInterruption(): string {
    const configured = this.queryConfigured(this.settings.accessInterruptionSelector);
    if (configured && isVisible(configured)) {
      const text = configured.textContent?.trim().replace(/\s+/g, " ").slice(0, 100);
      return `Configured access interruption is visible${text ? `: ${text}` : ""}`;
    }
    const candidates = [...document.querySelectorAll<HTMLElement>(
      "dialog[open], [role='dialog'][aria-modal='true'], .g-recaptcha, [id*='captcha' i], [class*='captcha' i], [class*='paywall' i]"
    )].filter(isVisible);
    const match = candidates.find((element) => /captcha|verify (you are|that you)|sign in|log in|subscribe|subscription|paywall|consent required/i.test(element.textContent ?? element.getAttribute("aria-label") ?? ""));
    if (!match) return "";
    const text = match.textContent?.trim().replace(/\s+/g, " ").slice(0, 100);
    return `Access or consent interruption detected${text ? `: ${text}` : ""}`;
  }

  private queryConfigured(selector: string): HTMLElement | null {
    if (!selector) return null;
    try { return document.querySelector<HTMLElement>(selector); } catch { return null; }
  }

  private safeConfiguredControl(selector: string): HTMLElement | null {
    if (!selector) return null;
    let matches: HTMLElement[];
    try { matches = [...document.querySelectorAll<HTMLElement>(selector)]; } catch { return null; }
    const eligible = matches.filter((element) => {
      if (!isVisible(element) || element.matches(":disabled,[aria-disabled='true']")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8 && !element.closest(
        "[role='dialog'][aria-modal='true'],dialog[open],form[action*='login' i],[class*='paywall' i],[class*='captcha' i],[id*='captcha' i]"
      );
    });
    // Automatic clicks require one unambiguous, visible, non-sensitive target.
    return eligible.length === 1 ? eligible[0] : null;
  }

  private validateSelector(field: SelectorField, selector: string) {
    if (!selector.trim()) return {
      ok: true, syntacticallyValid: true, matchCount: 0, visibleCount: 0, riskyCount: 0,
      frameUrl: location.href, warning: "Empty selector: this custom rule is disabled."
    };
    let matches: HTMLElement[];
    try { matches = [...document.querySelectorAll<HTMLElement>(selector)]; }
    catch (error) {
      return {
        ok: false, syntacticallyValid: false, matchCount: 0, visibleCount: 0, riskyCount: 0,
        frameUrl: location.href, warning: "", error: `Invalid CSS selector: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      };
    }
    const visible = matches.filter(isVisible);
    const risky = matches.filter((element) => !!element.closest(
      "[role='dialog'][aria-modal='true'],dialog[open],form[action*='login' i],[class*='paywall' i],[class*='captcha' i],[id*='captcha' i]"
    ));
    const control = ["fullscreenButtonSelector", "playButtonSelector", "retryButtonSelector", "liveButtonSelector"].includes(field);
    const wrongType = field === "selectedVideoSelector"
      ? matches.filter((element) => !(element instanceof HTMLVideoElement)).length
      : control ? matches.filter((element) => !element.matches("button,[role='button'],input[type='button'],input[type='submit']")).length : 0;
    const warnings: string[] = [];
    if (!matches.length) warnings.push("No current matches. The selector is valid, but the player may not be loaded yet or may be in another frame.");
    if (matches.length > 1) warnings.push(`${matches.length} elements match; use a more specific selector to avoid acting on the wrong element.`);
    if (matches.length && !visible.length) warnings.push("All current matches are hidden.");
    if (risky.length) warnings.push(`${risky.length} match(es) are inside a login, paywall, CAPTCHA, or modal context and will never be auto-clicked.`);
    if (wrongType) warnings.push(`${wrongType} match(es) have an unexpected element type for ${selectorLabel(field)}.`);
    if (!warnings.length) warnings.push(`Selector looks safe and currently matches ${visible.length} visible element${visible.length === 1 ? "" : "s"}.`);
    return {
      ok: true, syntacticallyValid: true, matchCount: matches.length, visibleCount: visible.length,
      riskyCount: risky.length, frameUrl: location.href, warning: warnings.join(" ")
    };
  }

  private isAdTransition(): boolean {
    const configured = this.queryConfigured(this.settings.adIndicatorSelector);
    if (configured && isVisible(configured)) return true;
    if (!this.primary) return false;
    const identity = `${this.primary.id} ${this.primary.className}`.toLowerCase();
    return /\b(ad|advert|promo)\b/.test(identity) && this.primary.muted && Number.isFinite(this.primary.duration) && this.primary.duration < 180;
  }

  private assessmentFromDiagnosis(diagnosis: FailureDiagnosis, fallback: HealthAssessment): HealthAssessment {
    if (diagnosis.kind === "NONE" || diagnosis.kind === "STARTUP_DELAY") return fallback;
    if (diagnosis.kind === "USER_PAUSED") return { state: "paused", detail: diagnosis.detail, confidence: 0, evidence: diagnosis.evidence };
    if (diagnosis.kind === "NETWORK_OFFLINE") return { state: "offline", detail: diagnosis.detail, confidence: 0, evidence: diagnosis.evidence };
    if (!diagnosis.recoverySafe) return { state: "monitoring", detail: diagnosis.detail, confidence: diagnosis.confidence, evidence: diagnosis.evidence };
    return { state: "suspected", detail: diagnosis.detail, confidence: diagnosis.confidence, evidence: diagnosis.evidence };
  }

  private async recordActionOutcome(action: RecoveryAction, success: boolean, durationMs: number): Promise<void> {
    await sendMessage({
      type: "RECORD_ACTION_OUTCOME", origin: this.origin,
      outcome: { action, failureKind: this.recoveryFailureKind, success, durationMs: Math.max(0, durationMs), timestamp: Date.now() }
    } satisfies RuntimeMessage).catch(() => undefined);
  }

  private async report(
    state: MonitorState,
    detail: string,
    confidence: number,
    evidence: HealthEvidence[],
    force = false
  ): Promise<void> {
    this.lastState = state;
    const key = `${state}:${detail}:${this.primary ? 1 : 0}:${Math.round(confidence)}`;
    const now = Date.now();
    if (!force && key === this.lastReportKey && now - this.lastReportAt < 15_000) return;
    this.lastReportKey = key;
    this.lastReportAt = now;
    const status: Omit<FrameStatus, "updatedAt"> = {
      state, detail, pageUrl: location.href, origin: this.origin, hasVideo: !!this.primary,
      score: this.primaryScore, confidence: Math.round(confidence), evidence,
      selectedVideoLabel: this.primaryLabel, diagnosis: this.diagnosis, streamKind: this.streamKind, liveIntent: this.liveIntent,
      liveEdgeLagSeconds: this.currentLiveLag, bufferAheadSeconds: this.currentBufferAhead,
      recoveryCycleId: this.recoveryCycleId, circuitState: this.circuitState, compatibility: this.compatibilityReport(), recoveryAction: this.currentRecoveryAction,
      nextActionAt: this.nextActionAt, online: navigator.onLine, frameToken: this.frames.token
    };
    await sendMessage({ type: "REPORT_STATUS", status } satisfies RuntimeMessage).catch(() => undefined);
  }

  private async log(event: string, detail: string, level: "info" | "warning" | "error" | "success", metadata?: Record<string, unknown>): Promise<void> {
    if (!this.settings.localHistoryEnabled) return;
    await sendMessage({
      type: "LOG_HISTORY",
      entry: { event, detail, level, url: location.href, metadata }
    } satisfies RuntimeMessage).catch(() => undefined);
  }

  private scheduleNext(): void {
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    if (this.destroyed) return;
    const eventMode = !!this.eventModeUntil && this.eventModeUntil > Date.now();
    const seconds = ["SUSPECTED_DOWN", "RECOVERING", "COUNTDOWN"].includes(this.lastState)
      ? this.settings.suspectCheckIntervalSeconds
      : this.lastState === "HEALTHY" ? (eventMode ? Math.min(3, this.settings.healthyCheckIntervalSeconds) : this.settings.healthyCheckIntervalSeconds) : this.settings.checkIntervalSeconds;
    this.timerId = window.setTimeout(() => void this.check(), seconds * 1000);
  }

  private startCountdown(seconds: number, reason: string): void {
    this.ui.showCountdown(seconds, reason, {
      cancel: () => {
        this.requestSuppressedUntil = Date.now() + this.settings.stallTimeoutSeconds * 1000;
        this.refreshRequested = false;
        this.ui.hideCountdown();
        void sendMessage({ type: "CANCEL_AUTO_REFRESH" } satisfies RuntimeMessage).catch(() => undefined);
        void this.log("countdown-canceled", "User canceled the pending page reload", "info");
      },
      extend: (amount) => void this.log("countdown-extended", `Countdown extended by ${amount} seconds`, "info"),
      expire: () => void this.performRefresh()
    });
    void this.report("COUNTDOWN", `Refresh scheduled: ${reason}`, 100, [], true);
  }

  private async performRefresh(): Promise<void> {
    const result = await sendMessage<{ allowed: boolean }>({ type: "RECORD_AUTO_REFRESH", origin: this.origin, pageUrl: location.href } satisfies RuntimeMessage)
      .catch(() => ({ allowed: false }));
    if (result.allowed) {
      await this.savePreferences();
      await this.captureSessionSnapshot();
      await this.report("REFRESHING", "Reloading the top-level page", 100, [], true);
      window.location.reload();
    } else {
      this.ui.toast("Automatic refresh paused because the refresh limit was reached.", "warning", 0);
      await this.report("PAUSED_TOO_MANY_REFRESHES", "Refresh loop protection is active", 100, [], true);
    }
  }

  private async maximizePrimary(manual: boolean): Promise<void> {
    const selection = this.candidates.select(this.primary, this.settings, this.recentInteraction, this.frames.getVisibilityFactor());
    if (!selection.video) { this.ui.toast("No visible video is available to maximize.", "warning"); return; }
    if (selection.video !== this.primary) this.setPrimary(selection.video, selection.score, selection.label);
    const video = selection.video;
    try { await video.requestFullscreen(); return; } catch { /* expected without a user gesture */ }
    if (this.settings.attemptNativeFullscreenClick) {
      const button = this.findFullscreenButton();
      if (button) {
        button.click();
        await delay(350);
        if (document.fullscreenElement) return;
      }
    }
    if (window.top !== window) await sendMessage({ type: "REQUEST_PARENT_MAXIMIZE" } satisfies RuntimeMessage).catch(() => undefined);
    if (this.settings.useCssMaximizeFallback) {
      this.applyCssMaximize(this.findVideoContainer(video));
      this.ui.toast("Browser fullscreen was blocked; using page maximize instead.", "info");
    } else {
      await this.report("MAXIMIZE_BLOCKED", "Browser requires a click before entering fullscreen", 0, [], true);
      this.ui.prompt(manual ? "Click to maximize stream" : "Fullscreen blocked — click to maximize", () => {
        void video.requestFullscreen().catch(() => this.ui.toast("Fullscreen is not available for this player.", "warning"));
      });
    }
  }

  private async pictureInPicture(): Promise<void> {
    if (!this.settings.enablePictureInPicture || !this.primary || !("requestPictureInPicture" in this.primary)) {
      this.ui.toast("Picture-in-Picture is not available for this player.", "warning");
      return;
    }
    try { await (this.primary as any).requestPictureInPicture(); }
    catch {
      this.ui.prompt("Click to open Picture-in-Picture", () => {
        void (this.primary as any)?.requestPictureInPicture().catch(() => this.ui.toast("Picture-in-Picture was blocked.", "warning"));
      });
    }
  }

  private async maximizeIframe(): Promise<void> {
    const iframe = this.frames.findIframe();
    if (!iframe) return;
    try { await iframe.requestFullscreen(); }
    catch { if (this.settings.useCssMaximizeFallback) this.applyCssMaximize(iframe); }
  }

  private findVideoContainer(video: HTMLVideoElement): HTMLElement {
    if (this.settings.videoContainerSelector) {
      try {
        const configured = video.closest<HTMLElement>(this.settings.videoContainerSelector);
        if (configured && !configured.closest("[role='dialog'][aria-modal='true'],dialog[open],[class*='paywall' i],[class*='captcha' i]")) return configured;
      } catch { /* invalid selector */ }
    }
    return video.parentElement ?? video;
  }

  private findFullscreenButton(): HTMLElement | null {
    const configured = this.safeConfiguredControl(this.settings.fullscreenButtonSelector);
    if (configured) return configured;
    return [...document.querySelectorAll<HTMLElement>("button,[role='button'],input[type='button']")].find((element) => {
      if (!isVisible(element)) return false;
      // Generic automatic clicks require a clear accessible label. IDs, classes,
      // and visible copy are intentionally excluded because they are too easy to
      // misclassify on arbitrary sites. A configured selector remains authoritative.
      const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-tooltip")]
        .filter((value) => typeof value === "string").join(" ").toLowerCase();
      return /full[ -]?screen|enter[ -]?full|maximize/.test(label) && !/exit/.test(label) &&
        !element.closest("[role='dialog'][aria-modal='true'],dialog[open],form[action*='login' i],[class*='paywall' i],[class*='captcha' i]");
    }) ?? null;
  }

  private applyCssMaximize(element: HTMLElement): void {
    this.exitCssMaximize();
    this.cssMaximized = element;
    element.classList.add("stream-reviver-maximized");
    this.ui.showExit(() => this.exitCssMaximize());
    this.schedulePreferenceSave();
  }

  private exitCssMaximize(): void {
    this.cssMaximized?.classList.remove("stream-reviver-maximized");
    this.cssMaximized = null;
    this.ui.hideExit();
    this.schedulePreferenceSave();
  }

  private beginPicker(field: SelectorField): void {
    this.stopPicker();
    this.pickerField = field;
    document.addEventListener("pointermove", this.onPickerMove, true);
    document.addEventListener("click", this.onPickerClick, true);
    document.addEventListener("keydown", this.onPickerKey, true);
    this.ui.toast(`Selector picker active: ${selectorLabel(field)}. Click an element or press Escape.`, "info", 0);
  }

  private stopPicker(): void {
    const wasPicking = this.pickerField !== null;
    this.pickerField = null;
    this.pickerTarget = null;
    document.removeEventListener("pointermove", this.onPickerMove, true);
    document.removeEventListener("click", this.onPickerClick, true);
    document.removeEventListener("keydown", this.onPickerKey, true);
    this.ui.hidePicker();
    if (wasPicking) this.ui.clearToast();
  }

  private readonly onPickerMove = (event: PointerEvent): void => {
    if (!this.pickerField || this.ui.containsEvent(event)) return;
    const target = pickerTarget(event.target, this.pickerField);
    this.pickerTarget = target;
    this.ui.showPicker(target?.getBoundingClientRect() ?? null, selectorLabel(this.pickerField), target ? generateSelector(target) : "No selectable element");
  };

  private readonly onPickerClick = (event: MouseEvent): void => {
    if (!this.pickerField || !this.pickerTarget || this.ui.containsEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const field = this.pickerField;
    const selector = generateSelector(this.pickerTarget);
    void sendMessage({ type: "SAVE_SITE_SELECTOR", origin: this.origin, field, selector } satisfies RuntimeMessage)
      .then(() => this.ui.toast(`${selectorLabel(field)} saved: ${selector}`, "success", 7000));
    this.stopPicker();
  };

  private readonly onPickerKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.stopPicker();
      this.ui.toast("Selector picker canceled.", "info");
      void sendMessage({ type: "CANCEL_SELECTOR_PICKER" } satisfies RuntimeMessage).catch(() => undefined);
    }
  };

  private readonly onUserInput = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest("video") as HTMLVideoElement | null : null;
    if (target) {
      this.lastUserInputAt = Date.now();
      this.recentInteraction.set(target, this.lastUserInputAt);
    }
  };

  private readonly onNetworkChange = (): void => {
    this.ui.toast(navigator.onLine ? "Connection restored; monitoring resumed." : "Offline; recovery attempts are paused.", navigator.onLine ? "success" : "warning");
    void this.check();
  };

  private isSnoozed(): boolean {
    if (this.snoozedUntil === null) return false;
    if (this.snoozedUntil === -1) return true;
    if (Date.now() < this.snoozedUntil) return true;
    this.snoozedUntil = null;
    return false;
  }

  private schedulePreferenceSave(): void {
    if (!this.settings.restorePlayerPreferences) return;
    if (this.preferenceTimer !== null) window.clearTimeout(this.preferenceTimer);
    this.preferenceTimer = window.setTimeout(() => void this.savePreferences(), 500);
  }

  private async savePreferences(): Promise<void> {
    if (!this.primary || !this.settings.restorePlayerPreferences) return;
    const preferences: PlayerPreferences = {
      volume: this.primary.volume, muted: this.primary.muted, playbackRate: this.primary.playbackRate,
      captionsShowing: [...this.primary.textTracks].some((track) => track.mode === "showing"),
      cssMaximized: !!this.cssMaximized, followingLive: this.liveIntent === "FOLLOWING_LIVE",
      pictureInPicture: (document as any).pictureInPictureElement === this.primary
    };
    this.savedPreferences = preferences;
    await sendMessage({ type: "SAVE_PLAYER_PREFERENCES", origin: this.origin, preferences } satisfies RuntimeMessage).catch(() => undefined);
  }

  private applyPreferences(video: HTMLVideoElement, preferences: PlayerPreferences): void {
    try {
      video.volume = Math.max(0, Math.min(1, preferences.volume));
      video.muted = preferences.muted;
      video.playbackRate = Math.max(0.25, Math.min(4, preferences.playbackRate));
      if (preferences.captionsShowing) {
        const track = [...video.textTracks][0];
        if (track) track.mode = "showing";
      }
      if (preferences.cssMaximized && this.settings.useCssMaximizeFallback) this.applyCssMaximize(this.findVideoContainer(video));
    } catch { /* player rejected a preference */ }
  }

  private async captureSessionSnapshot(): Promise<void> {
    if (!this.primary || !this.recoveryCycleId) return;
    const preferences: PlayerPreferences = {
      volume: this.primary.volume, muted: this.primary.muted, playbackRate: this.primary.playbackRate,
      captionsShowing: [...this.primary.textTracks].some((track) => track.mode === "showing"), cssMaximized: !!this.cssMaximized,
      followingLive: this.liveIntent === "FOLLOWING_LIVE", pictureInPicture: (document as any).pictureInPictureElement === this.primary
    };
    const snapshot: PlayerSessionSnapshot = {
      ...preferences, id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, origin: this.origin,
      pageUrlKey: `${location.origin}${location.pathname}`, playerLabel: this.primaryLabel, streamKind: this.streamKind,
      wasPlaying: !this.primary.paused && !this.userPaused,
      mediaPosition: this.streamKind === "VOD" ? finite(this.primary.currentTime) : null,
      scrollX, scrollY, createdAt: Date.now(), expiresAt: Date.now() + 30 * 60_000, recoveryCycleId: this.recoveryCycleId
    };
    this.sessionSnapshot = snapshot;
    await sendMessage({ type: "SAVE_SESSION_SNAPSHOT", snapshot } satisfies RuntimeMessage).catch(() => undefined);
  }

  private async restoreSessionSnapshot(video: HTMLVideoElement, snapshot: PlayerSessionSnapshot): Promise<void> {
    if (snapshot.expiresAt <= Date.now()) return;
    this.applyPreferences(video, snapshot);
    await delay(200);
    try {
      if (snapshot.streamKind === "VOD" && snapshot.mediaPosition !== null && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(Math.max(0, snapshot.mediaPosition), Math.max(0, video.duration - 0.25));
      } else if (snapshot.followingLive && video.seekable.length) {
        video.currentTime = Math.max(0, video.seekable.end(video.seekable.length - 1) - 1);
      }
      if (snapshot.wasPlaying && !this.userPaused) await video.play();
      if (!snapshot.cssMaximized) window.scrollTo(snapshot.scrollX, snapshot.scrollY);
      if (snapshot.pictureInPicture) this.ui.prompt("Restore Picture-in-Picture", () => void (video as any).requestPictureInPicture?.());
      this.sessionSnapshot = undefined;
      await sendMessage({ type: "CLEAR_SESSION_SNAPSHOT", origin: this.origin } satisfies RuntimeMessage).catch(() => undefined);
      await this.log("session-restored", "Player preferences and viewing state were restored", "success", { recoveryCycleId: snapshot.recoveryCycleId });
    } catch { /* a later healthy check or user gesture can complete restoration */ }
  }

  private compatibilityReport(): CompatibilityReport {
    const video = this.primary;
    const limitations: string[] = [];
    if (!video) limitations.push("No accessible HTML video is selected");
    if (!video || typeof (video as any).requestVideoFrameCallback !== "function") limitations.push("Presented-frame callbacks unavailable");
    if (!video || typeof video.getVideoPlaybackQuality !== "function") limitations.push("Playback-quality metrics unavailable");
    if (window.top !== window) limitations.push("Player is inside an embedded frame");
    if (!("wakeLock" in navigator)) limitations.push("Screen wake lock unavailable");
    return {
      htmlVideo: !!video, crossFrame: window.top !== window, frameCallbacks: !!video && typeof (video as any).requestVideoFrameCallback === "function",
      playbackQuality: !!video && typeof video.getVideoPlaybackQuality === "function", liveEdge: !!video?.seekable.length,
      pictureInPicture: !!video && "requestPictureInPicture" in video, fullscreen: !!video?.requestFullscreen,
      wakeLock: "wakeLock" in navigator, protocolBridge: !!this.protocolObservation, visualWatchdog: this.settings.enableVisualWatchdog,
      playerType: this.protocolObservation?.kind ?? (this.settings.declaredPlayerType === "AUTO"
        ? this.visualTarget?.tagName === "CANVAS" ? "CANVAS" : "HTML5" : this.settings.declaredPlayerType),
      level: video ? limitations.length <= 1 ? "FULL" : "PARTIAL" : this.visualTarget ? "PARTIAL" : "RESTRICTED", limitations
    };
  }

  private async updateWakeLock(healthy: boolean): Promise<void> {
    const eventModeActive = !!this.eventModeUntil && this.eventModeUntil > Date.now();
    if (!(this.settings.keepScreenAwake || eventModeActive) || !healthy || document.hidden || !("wakeLock" in navigator)) {
      if (this.wakeLock) { try { await this.wakeLock.release(); } catch { /* released */ } this.wakeLock = null; }
      return;
    }
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await (navigator as any).wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => { this.wakeLock = null; }, { once: true });
    } catch { this.wakeLock = null; }
  }

  private async sampleVisualProgress(target: HTMLElement | null = this.primary): Promise<boolean | null> {
    if (!target || document.hidden || Date.now() - this.lastVisualSampleAt < this.settings.visualSampleIntervalSeconds * 1000) return null;
    this.lastVisualSampleAt = Date.now();
    const rect = target.getBoundingClientRect();
    const response = await sendMessage<{ ok: boolean; dataUrl?: string }>({
      type: "REQUEST_VISUAL_SAMPLE", rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    } satisfies RuntimeMessage).catch((): { ok: boolean; dataUrl?: string } => ({ ok: false }));
    if (!response.ok || !response.dataUrl) return null;
    const hash = await visualHash(response.dataUrl, rect).catch(() => "");
    if (!hash) return null;
    const advanced = !!this.lastVisualHash && this.lastVisualHash !== hash;
    if (!advanced && this.lastVisualHash) this.repeatedVisualSamples += 1; else this.repeatedVisualSamples = 0;
    this.lastVisualHash = hash;
    return this.repeatedVisualSamples >= 2 ? false : advanced;
  }

  private findVisualTarget(): HTMLElement | null {
    let best: { element: HTMLElement; area: number } | null = null;
    for (const element of document.querySelectorAll<HTMLElement>("canvas, iframe")) {
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 40_000 || best && best.area >= area) continue;
      best = { element, area };
    }
    return best?.element ?? null;
  }

  private readonly onProtocolMessage = (event: MessageEvent): void => {
    if (event.source !== window || !event.data || event.data.channel !== "__stream_reviver_protocol_v3__") return;
    const value = event.data.observation as ProtocolObservation | undefined;
    if (!value || !["MSE", "HLS_JS", "DASH_JS", "WEBRTC"].includes(value.kind) || !Number.isFinite(value.observedAt)) return;
    const now = Date.now();
    if (Math.abs(now - value.observedAt) > 15_000) return;
    if (now - this.protocolWindowStartedAt > 10_000) { this.protocolWindowStartedAt = now; this.protocolMessagesInWindow = 0; }
    this.protocolMessagesInWindow += 1;
    if (this.protocolMessagesInWindow > 40) return;
    this.protocolObservation = {
      kind: value.kind, observedAt: value.observedAt, readyState: safeText(value.readyState, 50), fatalError: safeText(value.fatalError, 160),
      appendAgeMs: safeNumber(value.appendAgeMs), packetsReceivedDelta: safeNumber(value.packetsReceivedDelta), packetsLostDelta: safeNumber(value.packetsLostDelta),
      jitterSeconds: safeNumber(value.jitterSeconds), framesDecodedDelta: safeNumber(value.framesDecodedDelta), framesRenderedDelta: safeNumber(value.framesRenderedDelta), freezeCountDelta: safeNumber(value.freezeCountDelta)
    };
  };

  private readonly onPageHide = (event: PageTransitionEvent): void => {
    // A back-forward-cache page is frozen and later resumed with the same JS
    // realm. Keeping the monitor intact avoids a permanently inert restored page.
    if (!event.persisted) this.destroy();
  };

  private readonly destroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    if (this.preferenceTimer !== null) window.clearTimeout(this.preferenceTimer);
    this.detachPrimary();
    this.candidates.destroy();
    this.frames.destroy();
    this.stopPicker();
    this.ui.destroy();
    document.removeEventListener("pointerdown", this.onUserInput, true);
    document.removeEventListener("keydown", this.onUserInput, true);
    window.removeEventListener("online", this.onNetworkChange);
    window.removeEventListener("offline", this.onNetworkChange);
    window.removeEventListener("message", this.onProtocolMessage);
    window.removeEventListener("pagehide", this.onPageHide);
    if (this.wakeLock) void this.wakeLock.release().catch(() => undefined);
  };
}

function finite(value: number): number { return Number.isFinite(value) ? value : 0; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
function safeText(value: unknown, limit: number): string | undefined { return typeof value === "string" ? value.slice(0, limit) : undefined; }
function safeNumber(value: unknown): number | undefined { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
async function visualHash(dataUrl: string, rect: DOMRect): Promise<string> {
  const image = new Image(); image.src = dataUrl; await image.decode();
  const scaleX = image.naturalWidth / Math.max(1, innerWidth); const scaleY = image.naturalHeight / Math.max(1, innerHeight);
  const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
  const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return "";
  context.drawImage(image, Math.max(0, rect.x * scaleX), Math.max(0, rect.y * scaleY), Math.max(1, rect.width * scaleX), Math.max(1, rect.height * scaleY), 0, 0, 8, 8);
  const pixels = context.getImageData(0, 0, 8, 8).data; const values: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) values.push(Math.round((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => value >= average ? "1" : "0").join("");
}
function jitter(milliseconds: number): number { return Math.round(milliseconds * (0.9 + Math.random() * 0.2)); }
function liveEdgeLag(video: HTMLVideoElement): number | null {
  if (!video.seekable.length) return null;
  try { return Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime); } catch { return null; }
}
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}
function recoveryLabel(action: RecoveryAction): string {
  return ({
    WAIT: "wait and recheck", USER_PROMPT: "request a user playback gesture", REDISCOVER: "rediscover the primary player",
    PLAY: "resume playback", LIVE_EDGE: "seek to live edge", RETRY_BUTTON: "click configured retry control",
    MEDIA_RELOAD: "reload media element", IFRAME_RELOAD: "reload player frame", PAGE_RELOAD: "reload page",
    BACKUP_HANDOFF: "offer the configured backup stream"
  } satisfies Record<RecoveryAction, string>)[action];
}
function selectorLabel(field: SelectorField): string {
  return ({
    selectedVideoSelector: "primary video", videoContainerSelector: "video container", fullscreenButtonSelector: "fullscreen button",
    playButtonSelector: "play button", retryButtonSelector: "retry button", liveButtonSelector: "live button",
    errorSelector: "error indicator", accessInterruptionSelector: "access interruption", adIndicatorSelector: "advertisement indicator"
  } satisfies Record<SelectorField, string>)[field];
}
function pickerTarget(target: EventTarget | null, field: SelectorField): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (field === "selectedVideoSelector") return target.closest("video");
  return target;
}
function generateSelector(element: HTMLElement): string {
  if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
  for (const attribute of ["data-testid", "data-player", "aria-label", "title"]) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const selector = `${element.localName}[${attribute}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    try { if (document.querySelectorAll(selector).length === 1) return selector; } catch { /* continue */ }
  }
  const classes = [...element.classList].filter((value) => /^[a-z_-][a-z0-9_-]*$/i.test(value) && !/active|hover|selected|open|playing/i.test(value)).slice(0, 3);
  if (classes.length) {
    const selector = `${element.localName}.${classes.map(CSS.escape).join(".")}`;
    if (document.querySelectorAll(selector).length === 1) return selector;
  }
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.localName;
    const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.localName === current!.localName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    const selector = parts.join(" > ");
    if (document.querySelectorAll(selector).length === 1) return selector;
    current = current.parentElement;
  }
  return parts.join(" > ") || element.localName;
}
