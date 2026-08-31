import { ext } from "./api";

export function message(key: string, fallback: string, substitutions?: string | string[]): string {
  try { return ext.i18n?.getMessage(key, substitutions) || fallback; } catch { return fallback; }
}

export function localizeDocument(): void {
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = message(titleKey, document.title);
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key) element.textContent = message(key, element.textContent ?? "");
  }
}
