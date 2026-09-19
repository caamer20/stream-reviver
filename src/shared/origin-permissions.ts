export type PermissionBrowser = "chrome" | "firefox";

// Firefox match patterns do not support port numbers. Its browser grant covers
// a scheme/hostname; monitoring authorization must still use the exact origin.
export function browserOriginPattern(origin: string, browser: PermissionBrowser): string | null {
  if (origin === "file://") return "file:///*";
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${browser === "firefox" ? url.hostname : url.host}/*`;
  } catch { return null; }
}

export function hasOtherEnabledOriginSharingPermission(
  sites: Record<string, { enabled?: boolean }>, origin: string, browser: PermissionBrowser
): boolean {
  const pattern = browserOriginPattern(origin, browser);
  if (!pattern) return false;
  return Object.entries(sites).some(([other, site]) =>
    other !== origin && site.enabled === true && browserOriginPattern(other, browser) === pattern);
}
