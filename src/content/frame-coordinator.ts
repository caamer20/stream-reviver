const CHANNEL = "__stream_reviver_frame_v2__";

interface FrameHello { channel: string; type: "hello"; token: string }
interface FrameMetrics { channel: string; type: "metrics"; token: string; visibilityFactor: number }

export class FrameCoordinator {
  readonly token = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  private readonly frames = new Map<string, HTMLIFrameElement>();
  private helloTimer: number | null = null;
  private visibilityFactor = 1;

  start(onMetrics: () => void): void {
    window.addEventListener("message", this.onMessage);
    window.addEventListener("resize", this.refreshMetrics, { passive: true });
    this.onMetrics = onMetrics;
    if (window.top !== window) {
      this.sendHello();
      this.helloTimer = window.setInterval(() => this.sendHello(), 3000);
    }
  }

  getVisibilityFactor(): number { return this.visibilityFactor; }

  recoverIframe(token: string): boolean {
    const iframe = this.frames.get(token);
    if (!iframe?.isConnected) return false;
    const source = iframe.getAttribute("src");
    if (!source) return false;
    iframe.setAttribute("src", source);
    return true;
  }

  findIframe(token?: string): HTMLIFrameElement | null {
    if (token) return this.frames.get(token) ?? null;
    return [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
      .filter(isVisible)
      .sort((a, b) => area(b) - area(a))[0] ?? null;
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("resize", this.refreshMetrics);
    if (this.helloTimer !== null) window.clearInterval(this.helloTimer);
  }

  private onMetrics: () => void = () => undefined;

  private readonly onMessage = (event: MessageEvent): void => {
    const data = event.data as FrameHello | FrameMetrics | undefined;
    if (!data || data.channel !== CHANNEL || typeof data.token !== "string") return;
    if (data.type === "hello" && window.top === window) {
      const iframe = [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
        .find((candidate) => candidate.contentWindow === event.source);
      if (!iframe) return;
      this.frames.set(data.token, iframe);
      this.sendMetrics(data.token, iframe);
    } else if (data.type === "metrics" && data.token === this.token) {
      this.visibilityFactor = Math.max(0.02, Math.min(1, data.visibilityFactor));
      this.onMetrics();
      if (this.helloTimer !== null) {
        window.clearInterval(this.helloTimer);
        this.helloTimer = null;
      }
    }
  };

  private readonly refreshMetrics = (): void => {
    if (window.top !== window) return;
    for (const [token, iframe] of this.frames) this.sendMetrics(token, iframe);
  };

  private sendHello(): void {
    window.parent.postMessage({ channel: CHANNEL, type: "hello", token: this.token } satisfies FrameHello, "*");
  }

  private sendMetrics(token: string, iframe: HTMLIFrameElement): void {
    const rect = iframe.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    iframe.contentWindow?.postMessage({
      channel: CHANNEL,
      type: "metrics",
      token,
      visibilityFactor: (visibleWidth * visibleHeight) / viewportArea
    } satisfies FrameMetrics, "*");
  }
}

function area(element: Element): number {
  const rect = element.getBoundingClientRect();
  return rect.width * rect.height;
}
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}
