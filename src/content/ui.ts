export class UiLayer {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private countdownEnd = 0;
  private countdownTimer: number | null = null;
  private countdownExpire: (() => void) | null = null;

  showCountdown(
    seconds: number,
    reason: string,
    callbacks: { cancel: () => void; extend: (seconds: number) => void; expire: () => void }
  ): void {
    const root = this.ensure();
    if (root.getElementById("countdown")) return;
    this.countdownEnd = Date.now() + seconds * 1000;
    this.countdownExpire = callbacks.expire;
    const panel = document.createElement("section");
    panel.id = "countdown";
    panel.className = "panel countdown";
    panel.setAttribute("role", "status");
    panel.innerHTML = `<span class="mark">↻</span><span class="copy"><strong>Stream appears down</strong><span data-count></span><small></small></span><span class="buttons"></span>`;
    panel.querySelector("small")!.textContent = reason;
    const buttons = panel.querySelector(".buttons")!;
    buttons.append(
      button("+30 sec", () => { this.extendCountdown(30); callbacks.extend(30); }),
      button("Cancel", callbacks.cancel, "light")
    );
    root.append(panel);
    this.renderCountdown();
    this.countdownTimer = window.setInterval(() => this.renderCountdown(), 200);
  }

  extendCountdown(seconds: number): void {
    if (!this.shadow?.getElementById("countdown")) return;
    this.countdownEnd += seconds * 1000;
    this.renderCountdown();
  }

  hideCountdown(): void {
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownExpire = null;
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
  }

  containsEvent(event: Event): boolean {
    return !!this.host && event.composedPath().includes(this.host);
  }

  private ensure(): ShadowRoot {
    if (this.shadow) return this.shadow;
    this.host = document.createElement("div");
    this.host.id = "stream-reviver-ui-host";
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.append(style);
    (document.documentElement ?? document).append(this.host);
    return this.shadow;
  }

  private renderCountdown(): void {
    const label = this.shadow?.querySelector<HTMLElement>("[data-count]");
    if (!label) return;
    const remaining = Math.max(0, Math.ceil((this.countdownEnd - Date.now()) / 1000));
    label.textContent = `Refreshing in ${remaining} second${remaining === 1 ? "" : "s"}.`;
    if (remaining === 0) {
      const callback = this.countdownExpire;
      this.hideCountdown();
      callback?.();
    }
  }
}

function button(label: string, action: () => void, kind = "dark"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = kind;
  element.addEventListener("click", action);
  return element;
}

const STYLES = `
  *{box-sizing:border-box} .panel,.toast,button{font:14px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f8fafc}
  .panel,.toast,.floating{position:fixed;pointer-events:auto;border:1px solid rgba(255,255,255,.18);background:rgba(18,20,31,.97);box-shadow:0 14px 40px rgba(0,0,0,.38)}
  .countdown{top:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:min(680px,calc(100vw - 24px));padding:12px 14px;border-radius:12px}
  .mark{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:#6f48e8;font-size:19px;font-weight:700}
  .copy{display:block;min-width:160px;flex:1}.copy strong,.copy span,.copy small{display:block}.copy small{color:#b9bfd0;font-size:12px}.buttons{display:flex;gap:6px}
  button{pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px 10px;background:#303448;font-weight:700}button:hover{background:#3a3f56}button.light{background:#f8fafc;color:#161824}
  .toast{right:18px;bottom:18px;display:flex;align-items:center;gap:12px;max-width:min(450px,calc(100vw - 36px));padding:11px 13px;border-radius:10px}.toast.warning{background:#6b2d1d}.toast.success{background:#165c42}
  .floating{right:18px;top:18px;border-radius:9px;padding:10px 13px}.floating.danger{background:rgba(130,35,35,.96)}
  #picker-outline{position:fixed;pointer-events:none;border:3px solid #9b7df2;background:rgba(111,72,232,.12);box-shadow:0 0 0 99999px rgba(0,0,0,.18)}
  #picker-outline span{position:absolute;left:0;top:-32px;max-width:520px;padding:5px 8px;border-radius:6px;background:#6f48e8;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:700 12px/1.4 system-ui}
  @media(max-width:520px){.countdown{align-items:flex-start;flex-wrap:wrap}.buttons{width:100%;justify-content:flex-end}}
`;
