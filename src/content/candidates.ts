import type { EffectiveSettings } from "../shared/types";

export interface VideoSelection {
  video: HTMLVideoElement | null;
  score: number;
  label: string;
}

export class VideoCandidateManager {
  private readonly videos = new Set<HTMLVideoElement>();
  private readonly shadowRoots = new Set<ShadowRoot>();
  private readonly visibleRatios = new WeakMap<HTMLVideoElement, number>();
  private observer: MutationObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private resize: ResizeObserver | null = null;
  private debounceId: number | null = null;
  private lastShadowScanAt = 0;

  constructor(private readonly onRelevantChange: () => void, private debounceMs: number) {}

  start(): void {
    this.intersection = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) this.visibleRatios.set(entry.target as HTMLVideoElement, entry.intersectionRatio);
          this.scheduleChange();
        }, { threshold: [0, 0.1, 0.5, 0.9] })
      : null;
    this.resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.scheduleChange()) : null;
    if (!document.documentElement) return;
    this.observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof HTMLVideoElement || mutation.target instanceof HTMLIFrameElement) relevant = true;
          continue;
        }
        for (const node of mutation.addedNodes) relevant = this.addTree(node) || relevant;
        for (const node of mutation.removedNodes) {
          relevant = this.removeTree(node) || relevant;
          if (this.removeShadowRoots(node)) this.refreshObservationTargets();
        }
        if (!relevant && mutation.target instanceof Element && mutation.target.closest("video, iframe")) relevant = true;
      }
      if (relevant) this.scheduleChange();
    });
    this.observeTarget(document.documentElement);
    this.addTree(document);
  }

  updateDebounce(milliseconds: number): void {
    this.debounceMs = milliseconds;
  }

  select(
    current: HTMLVideoElement | null,
    settings: EffectiveSettings,
    recentInteraction: WeakMap<HTMLVideoElement, number>,
    frameVisibilityFactor = 1
  ): VideoSelection {
    this.prune();
    const pinned = this.findPinned(settings.selectedVideoSelector);
    if (pinned) return { video: pinned, score: Number.MAX_SAFE_INTEGER, label: describeVideo(pinned, true) };

    const scored = [...this.videos]
      .map((video) => ({ video, score: this.score(video, recentInteraction.get(video) ?? 0, frameVisibilityFactor) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { video: null, score: 0, label: "" };

    if (settings.lockPrimaryVideo && current?.isConnected) {
      const currentScore = this.score(current, recentInteraction.get(current) ?? 0, frameVisibilityFactor);
      if (currentScore > 0 && best.video !== current && best.score < currentScore * 1.35) {
        return { video: current, score: currentScore, label: describeVideo(current, false) };
      }
    }
    return { video: best.video, score: best.score, label: describeVideo(best.video, false) };
  }

  listVisible(): HTMLVideoElement[] {
    this.prune();
    return [...this.videos].filter((video) => this.score(video, 0, 1) > 0);
  }

  destroy(): void {
    this.observer?.disconnect();
    this.intersection?.disconnect();
    this.resize?.disconnect();
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.videos.clear();
    this.shadowRoots.clear();
  }

  private addTree(node: Node): boolean {
    let added = false;
    if (node instanceof HTMLVideoElement) added = this.addVideo(node) || added;
    if (node instanceof Document || node instanceof Element || node instanceof DocumentFragment) {
      for (const video of node.querySelectorAll?.("video") ?? []) added = this.addVideo(video as HTMLVideoElement) || added;
    }
    added = this.discoverOpenShadowRoots(node) || added;
    return added || node instanceof HTMLIFrameElement;
  }

  private removeTree(node: Node): boolean {
    let removed = false;
    if (node instanceof HTMLVideoElement) removed = this.removeVideo(node) || removed;
    if (node instanceof Element || node instanceof DocumentFragment) {
      for (const video of node.querySelectorAll?.("video") ?? []) removed = this.removeVideo(video as HTMLVideoElement) || removed;
    }
    return removed || node instanceof HTMLIFrameElement;
  }

  private addVideo(video: HTMLVideoElement): boolean {
    if (this.videos.has(video)) return false;
    this.videos.add(video);
    this.intersection?.observe(video);
    this.resize?.observe(video);
    return true;
  }

  private removeVideo(video: HTMLVideoElement): boolean {
    const removed = this.videos.delete(video);
    if (removed) {
      this.intersection?.unobserve(video);
      this.resize?.unobserve(video);
    }
    return removed;
  }

  private prune(): void {
    for (const video of this.videos) if (!video.isConnected) this.removeVideo(video);
    let rootsChanged = false;
    for (const root of this.shadowRoots) {
      if (!root.host.isConnected) {
        this.shadowRoots.delete(root);
        rootsChanged = true;
      }
    }
    if (rootsChanged) this.refreshObservationTargets();
    // attachShadow() itself does not necessarily produce a light-DOM mutation.
    // A throttled scan finds newly attached open roots without continuously
    // walking high-churn documents.
    if (Date.now() - this.lastShadowScanAt >= 10_000) {
      this.lastShadowScanAt = Date.now();
      this.discoverOpenShadowRoots(document);
    }
  }

  private findPinned(selector: string): HTMLVideoElement | null {
    if (!selector) return null;
    try {
      for (const root of [document, ...this.shadowRoots] as Array<Document | ShadowRoot>) {
        const element = root.querySelector(selector);
        if (element instanceof HTMLVideoElement && element.isConnected) return element;
        const nested = element?.querySelector("video");
        if (nested instanceof HTMLVideoElement && nested.isConnected) return nested;
      }
      return null;
    } catch { return null; }
  }

  private discoverOpenShadowRoots(node: Node): boolean {
    let changed = false;
    const inspect = (element: Element): void => {
      const root = element.shadowRoot;
      if (!root || this.shadowRoots.has(root)) return;
      this.shadowRoots.add(root);
      this.observeTarget(root);
      this.addTree(root);
      changed = true;
    };
    if (node instanceof Element) inspect(node);
    if (node instanceof Document || node instanceof Element || node instanceof DocumentFragment) {
      for (const element of node.querySelectorAll?.("*") ?? []) inspect(element);
    }
    return changed;
  }

  private removeShadowRoots(node: Node): boolean {
    let changed = false;
    const remove = (element: Element): void => {
      const root = element.shadowRoot;
      if (!root || !this.shadowRoots.delete(root)) return;
      for (const video of root.querySelectorAll("video")) this.removeVideo(video);
      for (const nested of root.querySelectorAll("*")) remove(nested);
      changed = true;
    };
    if (node instanceof Element) remove(node);
    if (node instanceof Element || node instanceof DocumentFragment) {
      for (const element of node.querySelectorAll?.("*") ?? []) remove(element);
    }
    return changed;
  }

  private observeTarget(target: Node): void {
    this.observer?.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "src"]
    });
  }

  private refreshObservationTargets(): void {
    if (!this.observer || !document.documentElement) return;
    this.observer.disconnect();
    this.observeTarget(document.documentElement);
    for (const root of this.shadowRoots) if (root.host.isConnected) this.observeTarget(root);
  }

  private score(video: HTMLVideoElement, interactionAt: number, frameFactor: number): number {
    const rect = video.getBoundingClientRect();
    const ratio = this.visibleRatios.get(video);
    if (rect.width < 24 || rect.height < 24 || ratio === 0) return 0;
    const style = getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return 0;
    const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    let score = visibleWidth * visibleHeight * Math.max(0.05, frameFactor);
    if (!video.paused && !video.ended) score += Math.max(100_000, score * 0.55);
    if (!video.muted && video.volume > 0) score += 150_000;
    if (video.readyState >= 2) score += 25_000;
    if (Date.now() - interactionAt < 60_000) score += 225_000;
    const identity = `${video.id} ${video.className} ${video.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (/\b(ad|advert|promo|preview|trailer)\b/.test(identity)) score *= 0.2;
    if (Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 120 && video.muted) score *= 0.55;
    return score;
  }

  private scheduleChange(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.debounceId = window.setTimeout(() => {
      this.debounceId = null;
      this.onRelevantChange();
    }, this.debounceMs);
  }
}

export function describeVideo(video: HTMLVideoElement, pinned: boolean): string {
  const label = video.getAttribute("aria-label") || video.getAttribute("title") || video.id ||
    (typeof video.className === "string" ? video.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "");
  return `${pinned ? "Pinned " : ""}${label ? `video (${label})` : "HTML5 video"}`;
}
