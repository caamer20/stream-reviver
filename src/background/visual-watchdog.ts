export const VISUAL_HASH_WIDTH = 8;
export const VISUAL_HASH_HEIGHT = 8;
export const VISUAL_HASH_HEX_LENGTH = 16;
export const MIN_VISUAL_SAMPLE_INTERVAL_MS = 5_000;

const MAX_VIEWPORT_EDGE = 20_000;
const MAX_CAPTURE_DATA_URL_BYTES = 32 * 1024 * 1024;
const MIN_CROP_EDGE = 16;

export interface VisualRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualViewportSize {
  width: number;
  height: number;
}

export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualSampleAccessInput {
  frameId: number;
  senderActive: boolean;
  tabActive: boolean;
  pageVisible: boolean;
  disclaimerAcknowledged: boolean;
  visualPrivacyAcknowledged: boolean;
  globalEnabled: boolean;
  siteEnabled: boolean;
  featureEnabled: boolean;
  urlEnabled: boolean;
  exactOriginPermission: boolean;
  primaryOwner: boolean;
  originMatchesOwner: boolean;
  pageMatchesOwner: boolean;
  inFlight: boolean;
  lastSampleAt: number | null;
  now: number;
  intervalMs: number;
}

export interface VisualSampleAccessDecision {
  ok: boolean;
  unavailable?: boolean;
  error?: string;
}

/**
 * Pure, fail-closed authorization for a sensitive visual capture. Keeping the
 * complete gate in one function makes it straightforward to exhaustively test
 * every required precondition without exposing browser screenshot APIs.
 */
export function decideVisualSampleAccess(input: VisualSampleAccessInput): VisualSampleAccessDecision {
  if (input.frameId !== 0) return denied("Visual sampling is unavailable in embedded frames.");
  if (!input.disclaimerAcknowledged || !input.visualPrivacyAcknowledged) {
    return denied("Visual monitoring acknowledgements are required.");
  }
  if (!input.globalEnabled || !input.siteEnabled || !input.featureEnabled || !input.urlEnabled) {
    return denied("Visual monitoring is not enabled for this page.");
  }
  if (!input.exactOriginPermission) return denied("Exact site access is required for visual monitoring.");
  if (!input.primaryOwner || !input.originMatchesOwner || !input.pageMatchesOwner) {
    return denied("Only the current primary player may request a visual sample.");
  }
  if (!input.senderActive || !input.tabActive || !input.pageVisible) {
    return denied("Visual sampling requires the active visible tab.");
  }
  if (input.inFlight) return denied("A visual sample is already in progress.", true);
  const intervalMs = Math.max(MIN_VISUAL_SAMPLE_INTERVAL_MS, finiteOr(input.intervalMs, MIN_VISUAL_SAMPLE_INTERVAL_MS));
  if (input.lastSampleAt !== null && input.now - input.lastSampleAt < intervalMs) {
    return denied("Visual sampling is rate limited.", true);
  }
  return { ok: true };
}

/** Maps a CSS-pixel crop in the top-level viewport into captured-image pixels. */
export function mapVisualCrop(
  rect: VisualRectangle,
  viewport: VisualViewportSize,
  imageWidth: number,
  imageHeight: number
): PixelCrop | null {
  if (!isFiniteRectangle(rect) || !isFiniteViewport(viewport)) return null;
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth < 1 || imageHeight < 1 ||
    imageWidth > MAX_VIEWPORT_EDGE * 4 || imageHeight > MAX_VIEWPORT_EDGE * 4) return null;
  if (rect.width < MIN_CROP_EDGE || rect.height < MIN_CROP_EDGE ||
    rect.width > MAX_VIEWPORT_EDGE || rect.height > MAX_VIEWPORT_EDGE) return null;

  const left = Math.max(0, Math.min(viewport.width, rect.x));
  const top = Math.max(0, Math.min(viewport.height, rect.y));
  const right = Math.max(0, Math.min(viewport.width, rect.x + rect.width));
  const bottom = Math.max(0, Math.min(viewport.height, rect.y + rect.height));
  if (right - left < MIN_CROP_EDGE || bottom - top < MIN_CROP_EDGE) return null;

  const scaleX = imageWidth / viewport.width;
  const scaleY = imageHeight / viewport.height;
  const x = Math.max(0, Math.min(imageWidth - 1, Math.floor(left * scaleX)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.floor(top * scaleY)));
  const endX = Math.max(x + 1, Math.min(imageWidth, Math.ceil(right * scaleX)));
  const endY = Math.max(y + 1, Math.min(imageHeight, Math.ceil(bottom * scaleY)));
  return { x, y, width: endX - x, height: endY - y };
}

/**
 * Produces a fixed 64-bit average hash from an already downsampled 8x8 RGBA
 * buffer. It is a similarity token, not a content identifier or telemetry ID.
 */
export function perceptualVisualHash(pixels: Uint8ClampedArray): string | null {
  if (pixels.length !== VISUAL_HASH_WIDTH * VISUAL_HASH_HEIGHT * 4) return null;
  const luminance: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    // Integer Rec. 601 luma. Alpha is ignored because browser screenshots are
    // opaque and the canvas never mixes page-controlled pixels with transparency.
    luminance.push((299 * pixels[index] + 587 * pixels[index + 1] + 114 * pixels[index + 2]) / 1000);
  }
  const average = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  let hash = "";
  for (let offset = 0; offset < luminance.length; offset += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) nibble = (nibble << 1) | (luminance[offset + bit] >= average ? 1 : 0);
    hash += nibble.toString(16);
  }
  return hash.length === VISUAL_HASH_HEX_LENGTH ? hash : null;
}

/**
 * Decodes, crops, downsamples, and hashes a capture entirely in the privileged
 * extension context. The caller must discard the data URL immediately after
 * this function resolves and must return only the resulting fixed-size hash.
 */
export async function hashCapturedVisual(
  dataUrl: string,
  rect: VisualRectangle,
  viewport: VisualViewportSize
): Promise<string | null> {
  const createBitmap = globalThis.createImageBitmap;
  const Canvas = globalThis.OffscreenCanvas;
  if (typeof createBitmap !== "function" || typeof Canvas !== "function" || typeof globalThis.atob !== "function") return null;
  const blob = captureDataUrlToBlob(dataUrl);
  if (!blob) return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createBitmap(blob);
    const crop = mapVisualCrop(rect, viewport, bitmap.width, bitmap.height);
    if (!crop) return null;
    const canvas = new Canvas(VISUAL_HASH_WIDTH, VISUAL_HASH_HEIGHT);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, VISUAL_HASH_WIDTH, VISUAL_HASH_HEIGHT);
    return perceptualVisualHash(context.getImageData(0, 0, VISUAL_HASH_WIDTH, VISUAL_HASH_HEIGHT).data);
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

function captureDataUrlToBlob(dataUrl: string): Blob | null {
  if (dataUrl.length < 32 || dataUrl.length > MAX_CAPTURE_DATA_URL_BYTES) return null;
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return null;
  try {
    const decoded = globalThis.atob(match[2]);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return new Blob([bytes], { type: match[1].toLowerCase() });
  } catch {
    return null;
  }
}

function isFiniteRectangle(rect: VisualRectangle): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
}

function isFiniteViewport(viewport: VisualViewportSize): boolean {
  return Number.isFinite(viewport.width) && Number.isFinite(viewport.height) &&
    viewport.width >= 1 && viewport.height >= 1 && viewport.width <= MAX_VIEWPORT_EDGE && viewport.height <= MAX_VIEWPORT_EDGE;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function denied(error: string, unavailable = false): VisualSampleAccessDecision {
  return { ok: false, unavailable, error };
}
