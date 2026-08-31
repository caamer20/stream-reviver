/**
 * Creates a privacy-safe exact navigation binding. The durable recovery ledger
 * stores only this digest, never a page query string, fragment, or credential.
 */
export async function navigationBindingKey(value: string): Promise<string | null> {
  let canonical: string;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) return null;
    canonical = parsed.href;
  } catch { return null; }
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}
