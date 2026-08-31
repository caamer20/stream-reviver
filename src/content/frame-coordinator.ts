const CHANNEL = "__stream_reviver_frame_v2__";
export const FRAME_ROUTE_STALE_MS = 20_000;
export const FRAME_RECOVERY_ACK_TIMEOUT_MS = 2_000;

interface FrameHello { channel: string; type: "hello"; token: string; hops: number }
interface FrameMetrics { channel: string; type: "metrics"; token: string; visibilityFactor: number }
interface FrameRecover { channel: string; type: "recover"; token: string; requestId: string }
interface FrameRecoverAck { channel: string; type: "recover-ack"; token: string; requestId: string; ok: boolean }
type FrameMessage = FrameHello | FrameMetrics | FrameRecover | FrameRecoverAck;
interface FrameEntry { element: HTMLIFrameElement; lastSeenAt: number; hops: number }
interface PendingRecovery {
  token: string;
  source: Window;
  timer: number;
  resolve: (delivered: boolean) => void;
}

export interface RectBounds { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** Coordinates cross-origin frame visibility and routes iframe recovery only
 * along a recently confirmed child path. Page messages advertise routes, but
 * are never treated as credentials; recovery still requires the background's
 * primary-player lease and one-use authorization. */
export class FrameCoordinator {
  readonly token = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  private readonly frames = new Map<string, FrameEntry>();
  private readonly pendingRecoveries = new Map<string, PendingRecovery>();
  private heartbeatTimer: number | null = null;
  private refreshFrame: number | null = null;
  private visibilityFactor = 1;
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private routeMutationObserver: MutationObserver | null = null;
  private layoutMutationObserver: MutationObserver | null = null;

  start(onMetrics: () => void): void {
    window.addEventListener("message", this.onMessage);
    window.addEventListener("resize", this.queueMetricsRefresh, { passive: true });
    window.addEventListener("scroll", this.queueMetricsRefresh, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", this.queueMetricsRefresh, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.queueMetricsRefresh, { passive: true });
    document.addEventListener("visibilitychange", this.queueMetricsRefresh);
    this.onMetrics = onMetrics;
    this.installLayoutObservers();
    if (window.top !== window) this.sendHello();
    this.refreshMetrics();
    this.heartbeatTimer = window.setInterval(() => {
      if (window.top !== window) this.sendHello();
      this.refreshMetrics();
    }, 5_000);
  }

  getVisibilityFactor(): number { return this.visibilityFactor; }

  async recoverIframe(token: string): Promise<boolean> {
    this.pruneRoutes();
    const entry = this.frames.get(token);
    if (!entry || !isFrameRouteFresh(entry.lastSeenAt, entry.element.isConnected)) return false;
    if (entry.hops > 0) return this.deliverRecovery(entry, token);
    return reloadBoundIframe(entry.element);
  }

  findIframe(token?: string): HTMLIFrameElement | null {
    this.pruneRoutes();
    if (token) return this.frames.get(token)?.element ?? null;
    return [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
      .filter(isVisible)
      .sort((a, b) => area(b) - area(a))[0] ?? null;
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("resize", this.queueMetricsRefresh);
    window.removeEventListener("scroll", this.queueMetricsRefresh, true);
    window.visualViewport?.removeEventListener("resize", this.queueMetricsRefresh);
    window.visualViewport?.removeEventListener("scroll", this.queueMetricsRefresh);
    document.removeEventListener("visibilitychange", this.queueMetricsRefresh);
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.refreshFrame !== null) window.cancelAnimationFrame(this.refreshFrame);
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.routeMutationObserver?.disconnect();
    this.layoutMutationObserver?.disconnect();
    for (const pending of this.pendingRecoveries.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingRecoveries.clear();
    this.frames.clear();
  }

  private onMetrics: () => void = () => undefined;

  private readonly onMessage = (event: MessageEvent): void => {
    const data = parseFrameMessage(event.data);
    if (!data) return;
    if (data.type === "hello") {
      const iframe = [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
        .find((candidate) => candidate.contentWindow === event.source);
      if (!iframe) return;
      const existing = this.frames.get(data.token);
      // Pin the first live route so a sibling cannot replay a public token and
      // redirect an already-authorized recovery action.
      if (existing && isFrameRouteFresh(existing.lastSeenAt, existing.element.isConnected) && existing.element !== iframe) return;
      this.frames.set(data.token, { element: iframe, lastSeenAt: Date.now(), hops: data.hops });
      this.observeFrame(iframe);
      this.sendMetrics(data.token, iframe, this.visibilityFactor);
      if (window.top !== window && data.hops < 20) {
        window.parent.postMessage({ ...data, hops: data.hops + 1 } satisfies FrameHello, "*");
      }
      return;
    }
    if (data.type === "metrics" && data.token === this.token) {
      if (event.source !== window.parent) return;
      const next = clampFactor(data.visibilityFactor);
      if (Math.abs(next - this.visibilityFactor) >= 0.001) {
        this.visibilityFactor = next;
        this.onMetrics();
      }
      return;
    }
    if (data.type === "metrics") {
      if (event.source !== window.parent) return;
      const entry = this.frames.get(data.token);
      if (entry && isFrameRouteFresh(entry.lastSeenAt, entry.element.isConnected)) {
        this.sendMetrics(data.token, entry.element, data.visibilityFactor);
      }
      return;
    }
    if (data.type === "recover") {
      if (event.source === window.parent) void this.handleRecoveryRequest(data);
      return;
    }
    const pending = this.pendingRecoveries.get(data.requestId);
    if (!pending || pending.token !== data.token || event.source !== pending.source) return;
    this.settleRecovery(data.requestId, data.ok);
  };

  private async handleRecoveryRequest(message: FrameRecover): Promise<void> {
    this.pruneRoutes();
    const entry = this.frames.get(message.token);
    let recovered = false;
    if (entry && isFrameRouteFresh(entry.lastSeenAt, entry.element.isConnected)) {
      recovered = entry.hops > 0
        ? await this.deliverRecovery(entry, message.token)
        : reloadBoundIframe(entry.element);
    }
    window.parent.postMessage({
      channel: CHANNEL, type: "recover-ack", token: message.token,
      requestId: message.requestId, ok: recovered
    } satisfies FrameRecoverAck, "*");
  }

  private deliverRecovery(entry: FrameEntry, token: string): Promise<boolean> {
    const source = entry.element.contentWindow;
    if (!source || !isFrameRouteFresh(entry.lastSeenAt, entry.element.isConnected)) return Promise.resolve(false);
    const requestId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => this.settleRecovery(requestId, false), FRAME_RECOVERY_ACK_TIMEOUT_MS);
      this.pendingRecoveries.set(requestId, { token, source, timer, resolve });
      try {
        source.postMessage({ channel: CHANNEL, type: "recover", token, requestId } satisfies FrameRecover, "*");
      } catch {
        this.settleRecovery(requestId, false);
      }
    });
  }

  private settleRecovery(requestId: string, delivered: boolean): void {
    const pending = this.pendingRecoveries.get(requestId);
    if (!pending) return;
    this.pendingRecoveries.delete(requestId);
    window.clearTimeout(pending.timer);
    pending.resolve(delivered);
  }

  private installLayoutObservers(): void {
    if (typeof IntersectionObserver === "function") {
      this.intersectionObserver = new IntersectionObserver(this.queueMetricsRefresh, { threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] });
    }
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(this.queueMetricsRefresh);
      if (document.documentElement) this.resizeObserver.observe(document.documentElement);
    }
    if (typeof MutationObserver === "function" && document.documentElement) {
      this.routeMutationObserver = new MutationObserver(this.queueMetricsRefresh);
      this.layoutMutationObserver = new MutationObserver(this.queueMetricsRefresh);
      // Child-list observation catches removed/reparented routes. Attribute
      // observation is installed only on a bound iframe and its ancestors in
      // observeFrame(), avoiding a whole-page style/class mutation tax.
      this.routeMutationObserver.observe(document.documentElement, {
        subtree: true, childList: true
      });
    }
  }

  private observeFrame(iframe: HTMLIFrameElement): void {
    this.intersectionObserver?.observe(iframe);
    this.resizeObserver?.observe(iframe);
    for (let current: Element | null = iframe; current; current = current.parentElement) {
      this.layoutMutationObserver?.observe(current, {
        attributes: true, attributeFilter: ["style", "class", "hidden", "open", "width", "height"]
      });
    }
  }

  private readonly queueMetricsRefresh = (): void => {
    if (this.refreshFrame !== null) return;
    this.refreshFrame = window.requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.refreshMetrics();
    });
  };

  private readonly refreshMetrics = (): void => {
    this.pruneRoutes();
    for (const [token, entry] of this.frames) this.sendMetrics(token, entry.element, this.visibilityFactor);
  };

  private pruneRoutes(now = Date.now()): void {
    for (const [token, entry] of this.frames) {
      if (isFrameRouteFresh(entry.lastSeenAt, entry.element.isConnected, now)) continue;
      this.intersectionObserver?.unobserve(entry.element);
      this.resizeObserver?.unobserve(entry.element);
      this.frames.delete(token);
      for (const [requestId, pending] of this.pendingRecoveries) {
        if (pending.token === token) this.settleRecovery(requestId, false);
      }
    }
  }

  private sendHello(): void {
    window.parent.postMessage({ channel: CHANNEL, type: "hello", token: this.token, hops: 0 } satisfies FrameHello, "*");
  }

  private sendMetrics(token: string, iframe: HTMLIFrameElement, parentFactor: number): void {
    const target = iframe.contentWindow;
    if (!target) return;
    target.postMessage({
      channel: CHANNEL,
      type: "metrics",
      token,
      visibilityFactor: frameVisibilityFactor(iframe, parentFactor)
    } satisfies FrameMetrics, "*");
  }
}

function parseFrameMessage(value: unknown): FrameMessage | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<FrameMessage>;
  if (data.channel !== CHANNEL || typeof data.type !== "string" || typeof data.token !== "string" || data.token.length > 200) return null;
  if (data.type === "hello") return Number.isInteger(data.hops) && (data.hops as number) >= 0 && (data.hops as number) <= 20 ? data as FrameHello : null;
  if (data.type === "metrics") return typeof data.visibilityFactor === "number" && Number.isFinite(data.visibilityFactor) ? data as FrameMetrics : null;
  if (data.type === "recover") return typeof data.requestId === "string" && data.requestId.length <= 200 ? data as FrameRecover : null;
  if (data.type === "recover-ack") return typeof data.requestId === "string" && data.requestId.length <= 200 && typeof data.ok === "boolean"
    ? data as FrameRecoverAck : null;
  return null;
}

function frameVisibilityFactor(iframe: HTMLIFrameElement, parentFactor: number): number {
  if (document.visibilityState === "hidden" || !isRenderedWithAncestors(iframe)) return 0;
  const rect = bounds(iframe.getBoundingClientRect());
  const clips: RectBounds[] = [{ left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight }];
  for (let ancestor = iframe.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const clipX = clipsOverflow(style.overflowX);
    const clipY = clipsOverflow(style.overflowY);
    if (!clipX && !clipY) continue;
    const ancestorRect = bounds(ancestor.getBoundingClientRect());
    clips.push({
      left: clipX ? ancestorRect.left : -Infinity,
      right: clipX ? ancestorRect.right : Infinity,
      top: clipY ? ancestorRect.top : -Infinity,
      bottom: clipY ? ancestorRect.bottom : Infinity,
      width: ancestorRect.width,
      height: ancestorRect.height
    });
  }
  return clampFactor(parentFactor * computeClippedAreaRatio(rect, clips));
}

/** Pure geometry helper exported for deterministic routing/visibility tests. */
export function computeClippedAreaRatio(rect: RectBounds, clips: RectBounds[]): number {
  const total = Math.max(0, rect.width) * Math.max(0, rect.height);
  if (total <= 0) return 0;
  let left = rect.left;
  let right = rect.right;
  let top = rect.top;
  let bottom = rect.bottom;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    right = Math.min(right, clip.right);
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  return clampFactor((Math.max(0, right - left) * Math.max(0, bottom - top)) / total);
}

export function isFrameRouteFresh(lastSeenAt: number, connected: boolean, now = Date.now()): boolean {
  return connected && Number.isFinite(lastSeenAt) && now >= lastSeenAt && now - lastSeenAt <= FRAME_ROUTE_STALE_MS;
}

function bounds(rect: DOMRect | DOMRectReadOnly): RectBounds {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function clipsOverflow(value: string): boolean { return value !== "visible" && value !== "clip-path"; }

function isRenderedWithAncestors(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if ((current as HTMLElement).hidden || style.display === "none" || style.visibility === "hidden" ||
      style.visibility === "collapse" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) return false;
  }
  return true;
}

function reloadBoundIframe(iframe: HTMLIFrameElement): boolean {
  const source = iframe.getAttribute("src");
  if (!source) return false;
  iframe.setAttribute("src", source);
  return true;
}

function area(element: Element): number {
  const rect = element.getBoundingClientRect();
  return rect.width * rect.height;
}
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && isRenderedWithAncestors(element);
}
function clampFactor(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
