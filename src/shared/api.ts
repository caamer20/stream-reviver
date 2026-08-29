export const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome;
import { isRuntimeMessage } from "./validation";

const usesPromises = typeof (globalThis as any).browser !== "undefined";

export function apiCall<T>(method: (...args: any[]) => any, context: unknown, ...args: any[]): Promise<T> {
  if (usesPromises) {
    try {
      return Promise.resolve(method.apply(context, args)) as Promise<T>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise<T>((resolve, reject) => {
    method.apply(context, [
      ...args,
      (result: T) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(result);
      }
    ]);
  });
}

export function sendMessage<T = unknown>(message: unknown): Promise<T> {
  return apiCall<T>(ext.runtime.sendMessage, ext.runtime, message);
}

export function sendTabMessage<T = unknown>(
  tabId: number,
  message: unknown,
  options?: { frameId?: number }
): Promise<T> {
  return options
    ? apiCall<T>(ext.tabs.sendMessage, ext.tabs, tabId, message, options)
    : apiCall<T>(ext.tabs.sendMessage, ext.tabs, tabId, message);
}

export function addAsyncMessageListener(
  handler: (message: any, sender: chrome.runtime.MessageSender) => Promise<unknown> | unknown
): () => void {
  const listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      const response = { ok: false, error: "Invalid or oversized extension message" };
      if (usesPromises) return Promise.resolve(response) as any;
      sendResponse(response);
      return false;
    }
    if (usesPromises) return handler(message, sender) as any;
    Promise.resolve(handler(message, sender)).then(sendResponse, (error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  };
  ext.runtime.onMessage.addListener(listener);
  return () => ext.runtime.onMessage.removeListener(listener);
}

export async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await apiCall<chrome.tabs.Tab[]>(ext.tabs.query, ext.tabs, {
    active: true,
    currentWindow: true
  });
  return tabs[0];
}

export function getOrigin(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") {
      return null;
    }
    return parsed.protocol === "file:" ? "file://" : parsed.origin;
  } catch {
    return null;
  }
}

export function originPattern(origin: string): string | null {
  if (origin === "file://") return "file:///*";
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}
