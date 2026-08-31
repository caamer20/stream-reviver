export const MIN_EMBEDDED_VISIBLE_WIDTH = 240;
export const MIN_EMBEDDED_VISIBLE_HEIGHT = 135;
export const MIN_EMBEDDED_VISIBLE_AREA = 40_000;

export interface EmbeddedFrameObservation {
  source: string | null;
  identity: string;
  rendered: boolean;
  visibleWidth: number;
  visibleHeight: number;
  opaque: boolean;
  sensitive: boolean;
}

export interface EmbeddedVisibilityDiagnostic {
  origin: string | null;
  originCount: number;
  detail: string;
}

interface VisibleBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const AD_LIKE_MARKER = /(?:^|[^a-z0-9])(?:ad|adform|adnxs|adroll|ads|adsystem|advert|advertisement|advertisements|advertising|adserver|adservice|banner|criteo|doubleclick|googlesyndication|moatads|openx|outbrain|postroll|preroll|promo|promoted|pubmatic|rubiconproject|sponsor|sponsored|taboola|teads|tracker|tracking|yieldmo)(?:[^a-z0-9]|$)/i;
const SENSITIVE_MARKER = /(?:^|[^a-z0-9])(?:access-control|account|accounts|admin|auth|authentication|authorize|bank|banking|billing|captcha|challenge|checkout|consent|credential|credentials|duosecurity|identity|log-in|login|oauth|okta|onelogin|password|payment|permission|permissions|sign-in|signin|sign-up|signup|sso|verification|verify|wallet)(?:[^a-z0-9]|$)/i;
const SENSITIVE_PERMISSION = /(?:^|[;,\s])(?:camera|clipboard-read|clipboard-write|geolocation|identity-credentials-get|microphone|payment)(?:$|[;,\s])/i;

/**
 * Selects only a conservative, origin-level advisory. Raw frame URLs never
 * leave this function, and ambiguity across origins intentionally removes even
 * the origin from the user-facing result.
 */
export function diagnoseEmbeddedVisibility(
  topLevelOrigin: string,
  frames: readonly EmbeddedFrameObservation[]
): EmbeddedVisibilityDiagnostic | null {
  const pageOrigin = httpOrigin(topLevelOrigin);
  if (!pageOrigin) return null;

  const plausibleOrigins = new Set<string>();
  for (const frame of frames) {
    if (!frame.rendered || frame.opaque || frame.sensitive || !isLarge(frame)) continue;
    const source = frame.source?.trim();
    if (!source || source.length > 4_096) continue;

    let url: URL;
    try { url = new URL(source, `${pageOrigin}/`); }
    catch { continue; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === pageOrigin) continue;
    // Embedded credentials are not needed for this advisory and make the
    // source sensitive even though URL.origin itself would omit them.
    if (url.username || url.password) continue;

    const privateUrlText = boundedDecodedText(`${url.hostname} ${url.pathname} ${url.search} ${url.hash}`);
    const privateIdentityText = boundedDecodedText(frame.identity);
    if (AD_LIKE_MARKER.test(privateUrlText) || AD_LIKE_MARKER.test(privateIdentityText) ||
      SENSITIVE_MARKER.test(privateUrlText) || SENSITIVE_MARKER.test(privateIdentityText)) continue;
    plausibleOrigins.add(url.origin);
  }

  if (plausibleOrigins.size === 0) return null;
  if (plausibleOrigins.size > 1) {
    return {
      origin: null,
      originCount: plausibleOrigins.size,
      detail: "Multiple large cross-origin embedded frames are inaccessible from this page and may contain players. Enable their embedded origins separately in Settings to monitor them."
    };
  }

  const origin = plausibleOrigins.values().next().value as string;
  return {
    origin,
    originCount: 1,
    detail: `A large embedded frame from ${origin} may contain a player, but this page cannot inspect it. Enable ${origin} separately in Settings to monitor that embedded origin.`
  };
}

/** Reads DOM state, but delegates all URL and ambiguity decisions to the pure selector above. */
export function inspectEmbeddedVisibility(topLevelOrigin: string): EmbeddedVisibilityDiagnostic | null {
  const viewport = {
    width: Math.max(0, window.innerWidth),
    height: Math.max(0, window.innerHeight)
  };
  const observations = [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
    .map((frame) => observeFrame(frame, viewport));
  return diagnoseEmbeddedVisibility(topLevelOrigin, observations);
}

function observeFrame(
  frame: HTMLIFrameElement,
  viewport: { width: number; height: number }
): EmbeddedFrameObservation {
  const visible = visibleBounds(frame, viewport);
  const sandbox = frame.getAttribute("sandbox");
  const sandboxTokens = new Set((sandbox ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const opaque = frame.hasAttribute("srcdoc") || (sandbox !== null && !sandboxTokens.has("allow-same-origin"));
  const allow = frame.getAttribute("allow") ?? "";
  const sensitive = frame.hasAttribute("credentialless") || frame.hasAttribute("allowpaymentrequest") ||
    SENSITIVE_PERMISSION.test(allow) || frame.closest("form") !== null;

  return {
    source: frame.getAttribute("src"),
    identity: contextualIdentity(frame),
    rendered: visible !== null,
    visibleWidth: visible ? Math.max(0, visible.right - visible.left) : 0,
    visibleHeight: visible ? Math.max(0, visible.bottom - visible.top) : 0,
    opaque,
    sensitive
  };
}

function contextualIdentity(frame: HTMLIFrameElement): string {
  const parts: string[] = [];
  let current: Element | null = frame;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
    const className = typeof current.className === "string" ? current.className : "";
    parts.push(
      current.localName, current.id, className,
      current.getAttribute("name") ?? "", current.getAttribute("title") ?? "",
      current.getAttribute("aria-label") ?? "", current.getAttribute("role") ?? "",
      current.getAttribute("data-testid") ?? ""
    );
  }
  return parts.join(" ").slice(0, 2_000);
}

function visibleBounds(
  frame: HTMLIFrameElement,
  viewport: { width: number; height: number }
): VisibleBounds | null {
  if (!frame.isConnected || frame.hidden || frame.getAttribute("aria-hidden") === "true") return null;
  const rect = frame.getBoundingClientRect();
  if (![rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite)) return null;

  const bounds: VisibleBounds = {
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(viewport.width, rect.right),
    bottom: Math.min(viewport.height, rect.bottom)
  };
  for (let current: Element | null = frame; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if ((current as HTMLElement).hidden || current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
      style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) return null;
    if (current === frame) continue;

    const ancestorRect = current.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      bounds.left = Math.max(bounds.left, ancestorRect.left);
      bounds.right = Math.min(bounds.right, ancestorRect.right);
    }
    if (style.overflowY !== "visible") {
      bounds.top = Math.max(bounds.top, ancestorRect.top);
      bounds.bottom = Math.min(bounds.bottom, ancestorRect.bottom);
    }
  }
  return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
}

function isLarge(frame: EmbeddedFrameObservation): boolean {
  return Number.isFinite(frame.visibleWidth) && Number.isFinite(frame.visibleHeight) &&
    frame.visibleWidth >= MIN_EMBEDDED_VISIBLE_WIDTH && frame.visibleHeight >= MIN_EMBEDDED_VISIBLE_HEIGHT &&
    frame.visibleWidth * frame.visibleHeight >= MIN_EMBEDDED_VISIBLE_AREA;
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

function boundedDecodedText(value: string): string {
  const bounded = value.slice(0, 4_096).toLowerCase();
  try { return decodeURIComponent(bounded); }
  catch { return bounded; }
}
