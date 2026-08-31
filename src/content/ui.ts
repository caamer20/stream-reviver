export class UiLayer {
  private static readonly MAX_COUNTDOWN_RENDER_GAP_MS = 1_500;
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private countdownEnd = 0;
  private countdownTimer: number | null = null;
  private countdownExpire: (() => void) | null = null;
  private countdownCancel: (() => void | Promise<void>) | null = null;
  private countdownHeld = false;
  private countdownPainted = false;
  private countdownContinuityBroken = false;
  private lastCountdownRenderAt = 0;
  private countdownPaintFrame: number | null = null;
  private fullscreenListenerInstalled = false;

  showCountdown(
    deadline: number,
    reason: string,
    callbacks: { cancel: () => void | Promise<void>; extend: (seconds: number) => void | Promise<void>; expire: () => void | Promise<void> }
  ): boolean {
    if (!Number.isFinite(deadline) || deadline <= Date.now() ||
      document.visibilityState !== "visible" || !this.fullscreenCanRenderOverlay()) return false;
    const root = this.ensure();
    // Replace, rather than acknowledge, any stale panel so the visible
    // callbacks always carry the coordinator's current one-use action token.
    this.hideCountdown();
    // The coordinator owns the deadline. Never reconstruct it from rounded
    // seconds or the visible panel can outlive the privileged alarm.
    this.countdownEnd = deadline;
    this.countdownPainted = false;
    this.countdownContinuityBroken = false;
    this.lastCountdownRenderAt = performance.now();
    this.countdownExpire = callbacks.expire;
    this.countdownCancel = callbacks.cancel;
    const panel = document.createElement("section");
    panel.id = "countdown";
    panel.className = "panel countdown";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Stream recovery countdown");
    panel.innerHTML = `<span class="mark" aria-hidden="true">↻</span><span class="copy"><strong>Stream appears down</strong><span data-count aria-live="polite"></span><small></small></span><span class="buttons"></span>`;
    panel.querySelector("small")!.textContent = reason;
    const buttons = panel.querySelector(".buttons")!;
    buttons.append(
      button("+30 sec", () => callbacks.extend(30)),
      button("Cancel", callbacks.cancel, "light")
    );
    root.append(panel);
    this.renderCountdown();
    this.countdownPaintFrame = requestAnimationFrame(() => {
      this.countdownPaintFrame = requestAnimationFrame(() => {
        this.countdownPaintFrame = null;
        this.countdownPainted = this.countdownIsRenderable();
        this.lastCountdownRenderAt = performance.now();
      });
    });
    this.countdownTimer = window.setInterval(() => this.renderCountdown(), 200);
    return panel.isConnected && this.host?.isConnected === true && this.fullscreenCanRenderOverlay();
  }

  extendCountdown(seconds: number): boolean {
    if (!this.countdownIsRenderable()) return false;
    this.countdownEnd += seconds * 1000;
    this.renderCountdown();
    return true;
  }

  setCountdownDeadline(deadline: number): boolean {
    if (!this.countdownIsRenderable() || !Number.isFinite(deadline)) return false;
    this.countdownEnd = Math.max(this.countdownEnd, deadline);
    this.renderCountdown();
    return true;
  }

  setCountdownHeld(held: boolean): void {
    this.countdownHeld = held && this.countdownIsRenderable();
    this.renderCountdown();
  }

  /** Consume the visible countdown at its authoritative deadline. The caller
   * may acknowledge a privileged reload only when this returns true. */
  finalizeCountdown(requestedDeadline = this.countdownEnd): boolean {
    const renderGap = performance.now() - this.lastCountdownRenderAt;
    if (!Number.isFinite(requestedDeadline) || requestedDeadline < this.countdownEnd ||
      Date.now() < this.countdownEnd || this.countdownHeld || !this.countdownPainted ||
      this.countdownContinuityBroken || renderGap > UiLayer.MAX_COUNTDOWN_RENDER_GAP_MS ||
      !this.countdownIsRenderable()) return false;
    const callback = this.countdownExpire;
    if (!callback) return false;
    this.hideCountdown();
    callback();
    return true;
  }

  hideCountdown(): void {
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownExpire = null;
    this.countdownCancel = null;
    this.countdownHeld = false;
    this.countdownPainted = false;
    this.countdownContinuityBroken = false;
    this.lastCountdownRenderAt = 0;
    if (this.countdownPaintFrame !== null) cancelAnimationFrame(this.countdownPaintFrame);
    this.countdownPaintFrame = null;
    this.shadow?.getElementById("countdown")?.remove();
  }

  toast(message: string, kind: "info" | "warning" | "success" = "info", duration = 5000): void {
    const root = this.ensure();
    root.getElementById("toast")?.remove();
    const toast = document.createElement("aside");
    toast.id = "toast";
    toast.className = `toast ${kind}`;
    toast.setAttribute("role", kind === "warning" ? "alert" : "status");
    const copy = document.createElement("span");
    copy.textContent = message;
    toast.append(copy);
    if (duration === 0) toast.append(button("Dismiss", () => toast.remove(), "light"));
    else window.setTimeout(() => toast.remove(), duration);
    root.append(toast);
  }

  clearToast(): void { this.shadow?.getElementById("toast")?.remove(); }

  prompt(label: string, action: () => void): void {
    const root = this.ensure();
    root.getElementById("prompt")?.remove();
    const prompt = button(label, () => { action(); prompt.remove(); });
    prompt.id = "prompt";
    prompt.classList.add("floating");
    root.append(prompt);
  }

  showExit(action: () => void): void {
    const root = this.ensure();
    root.getElementById("exit")?.remove();
    const exit = button("Exit maximize", action);
    exit.id = "exit";
    exit.classList.add("floating", "danger");
    root.append(exit);
  }

  hideExit(): void { this.shadow?.getElementById("exit")?.remove(); }

  showPicker(rect: DOMRect | null, title: string, help: string): void {
    const root = this.ensure();
    let outline = root.getElementById("picker-outline") as HTMLElement | null;
    if (!outline) {
      outline = document.createElement("div");
      outline.id = "picker-outline";
      outline.innerHTML = `<span></span>`;
      root.append(outline);
    }
    const label = outline.querySelector("span")!;
    label.textContent = `${title} — ${help}`;
    if (!rect) {
      Object.assign(outline.style, { display: "none" });
      return;
    }
    Object.assign(outline.style, {
      display: "block",
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`
    });
  }

  hidePicker(): void { this.shadow?.getElementById("picker-outline")?.remove(); }

  destroy(): void {
    this.hideCountdown();
    this.host?.remove();
    this.host = null;
    this.shadow = null;
    if (this.fullscreenListenerInstalled) document.removeEventListener("fullscreenchange", this.onFullscreenChange, true);
    this.fullscreenListenerInstalled = false;
  }

  containsEvent(event: Event): boolean {
    return !!this.host && event.composedPath().includes(this.host);
  }

  private ensure(): ShadowRoot {
    if (this.shadow) return this.shadow;
    this.host = document.createElement("div");
    this.host.id = "stream-reviver-ui-host";
    this.host.style.cssText = "all:initial!important;display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.append(style);
    this.mountHostForFullscreen();
    if (!this.fullscreenListenerInstalled) {
      document.addEventListener("fullscreenchange", this.onFullscreenChange, true);
      this.fullscreenListenerInstalled = true;
    }
    return this.shadow;
  }

  private renderCountdown(): void {
    const label = this.shadow?.querySelector<HTMLElement>("[data-count]");
    if (!label) return;
    const renderAt = performance.now();
    if (this.lastCountdownRenderAt > 0 &&
      renderAt - this.lastCountdownRenderAt > UiLayer.MAX_COUNTDOWN_RENDER_GAP_MS) {
      this.countdownContinuityBroken = true;
    }
    this.lastCountdownRenderAt = renderAt;
    if (this.countdownContinuityBroken || !this.countdownIsRenderable()) {
      const cancel = this.countdownCancel;
      this.hideCountdown();
      if (cancel) void Promise.resolve(cancel()).catch(() => undefined);
      return;
    }
    const remaining = Math.max(0, Math.ceil((this.countdownEnd - Date.now()) / 1000));
    label.textContent = this.countdownHeld ? "Updating countdown…" : `Refreshing in ${remaining} second${remaining === 1 ? "" : "s"}.`;
    if (remaining === 0 && !this.countdownHeld) {
      this.finalizeCountdown(this.countdownEnd);
    }
  }

  private countdownIsRenderable(): boolean {
    const host = this.host;
    const panel = this.shadow?.getElementById("countdown");
    if (document.visibilityState !== "visible" || !host?.isConnected || !panel ||
      !this.fullscreenCanRenderOverlay() || host.hidden) return false;
    try {
      const style = getComputedStyle(host);
      const hostRect = host.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0 &&
        style.contentVisibility !== "hidden" && style.clipPath === "none" &&
        hostRect.width > 1 && hostRect.height > 1 && panelRect.width > 1 && panelRect.height > 1;
    } catch {
      return false;
    }
  }

  private fullscreenCanRenderOverlay(): boolean {
    const fullscreen = document.fullscreenElement;
    if (!fullscreen) return true;
    // Replaced elements do not render arbitrary appended descendants. Mounting
    // the host there could produce a connected-but-invisible safety panel.
    return fullscreen instanceof HTMLElement &&
      !["AUDIO", "CANVAS", "EMBED", "IFRAME", "IMG", "INPUT", "OBJECT", "TEXTAREA", "VIDEO"]
        .includes(fullscreen.tagName);
  }

  private mountHostForFullscreen(): void {
    if (!this.host) return;
    const fullscreen = document.fullscreenElement;
    const target = fullscreen && this.fullscreenCanRenderOverlay() ? fullscreen : document.documentElement;
    (target ?? document).append(this.host);
  }

  private readonly onFullscreenChange = (): void => {
    if (this.fullscreenCanRenderOverlay()) {
      this.mountHostForFullscreen();
      return;
    }
    if (!this.shadow?.getElementById("countdown")) return;
    const cancel = this.countdownCancel;
    this.hideCountdown();
    if (cancel) void Promise.resolve(cancel()).catch(() => undefined);
  };
}

function button(label: string, action: () => void | Promise<void>, kind = "dark"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = kind;
  element.addEventListener("click", () => {
    element.disabled = true;
    Promise.resolve(action()).catch(() => undefined).finally(() => { if (element.isConnected) element.disabled = false; });
  });
  return element;
}

const STYLES = `
  *{box-sizing:border-box} .panel,.toast,button{font:14px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f8fafc}
  .panel,.toast,.floating{position:fixed;pointer-events:auto;border:1px solid rgba(255,255,255,.18);background:rgba(18,20,31,.97);box-shadow:0 14px 40px rgba(0,0,0,.38)}
  .countdown{top:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:min(680px,calc(100vw - 24px));padding:12px 14px;border-radius:12px}
  .mark{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:#6f48e8;font-size:19px;font-weight:700}
  .copy{display:block;min-width:160px;flex:1}.copy strong,.copy span,.copy small{display:block}.copy small{color:#b9bfd0;font-size:12px}.buttons{display:flex;gap:6px}
  button{pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px 10px;background:#303448;font-weight:700}button:hover{background:#3a3f56}button:focus-visible{outline:3px solid #c4b5fd;outline-offset:2px}button.light{background:#f8fafc;color:#161824}
  .toast{right:18px;bottom:18px;display:flex;align-items:center;gap:12px;max-width:min(450px,calc(100vw - 36px));padding:11px 13px;border-radius:10px}.toast.warning{background:#6b2d1d}.toast.success{background:#165c42}
  .floating{right:18px;top:18px;border-radius:9px;padding:10px 13px}.floating.danger{background:rgba(130,35,35,.96)}
  #picker-outline{position:fixed;pointer-events:none;border:3px solid #9b7df2;background:rgba(111,72,232,.12);box-shadow:0 0 0 99999px rgba(0,0,0,.18)}
  #picker-outline span{position:absolute;left:0;top:-32px;max-width:520px;padding:5px 8px;border-radius:6px;background:#6f48e8;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:700 12px/1.4 system-ui}
  @media(max-width:520px){.countdown{align-items:flex-start;flex-wrap:wrap}.buttons{width:100%;justify-content:flex-end}}
  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  @media(forced-colors:active){.panel,.toast,.floating,button{border:1px solid ButtonText}.mark{forced-color-adjust:none}}
`;
