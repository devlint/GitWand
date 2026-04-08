/**
 * GitWand — Locale registry
 *
 * To add a new language:
 * 1. Copy fr.ts → xx.ts, translate all values
 * 2. Import it here and add to `locales`
 * 3. Add a label in `localeLabels`
 *
 * TypeScript ensures every new locale has the exact same keys as fr.ts.
 */
import type { Locale } from "./fr";
import fr from "./fr";
import en from "./en";

export type SupportedLocale = "fr" | "en";

export const locales: Record<SupportedLocale, Locale> = { fr, en };

/** Human-readable labels for the settings UI. */
export const localeLabels: Record<SupportedLocale, string> = {
  fr: "Fran\u00e7ais",
  en: "English",
};

export const supportedLocales = Object.keys(locales) as SupportedLocale[];

export const DEFAULT_LOCALE: SupportedLocale = "fr";

/**
 * Detect the best locale from the browser / OS language.
 * navigator.language → "fr-FR" → "fr" → match or fallback.
 */
export function detectLocale(): SupportedLocale {
  try {
    const lang = navigator.language?.substring(0, 2)?.toLowerCase();
    if (lang && lang in locales) return lang as SupportedLocale;
  } catch {
    // SSR or no navigator
  }
  return DEFAULT_LOCALE;
}

export { type Locale, type LocaleKey } from "./fr";
