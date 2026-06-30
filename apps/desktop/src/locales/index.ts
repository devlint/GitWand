/**
 * GitWand — Locale registry
 *
 * To add a new language:
 * 1. Copy en.ts → xx.ts, translate all values
 * 2. Add a dynamic loader in `localeLoaders` and a label in `localeLabels`
 * 3. Add the code to the `SupportedLocale` union
 *
 * TypeScript ensures every new locale has the exact same keys as en.ts.
 *
 * Bundle note (P1.2): only `en` is bundled into the main chunk — it is the
 * default + synchronous fallback. The other locales are code-split into their
 * own chunks via `localeLoaders` and streamed in on demand (see `loadLocale`).
 * This keeps ~9k lines of translation data out of the initial bundle.
 */
import type { Locale } from "./en";
import en from "./en";

export type SupportedLocale = "en" | "fr" | "es" | "pt-BR" | "zh-CN";

/** Dynamic importers for the non-default locales (lazy chunks). */
const localeLoaders: Record<
  Exclude<SupportedLocale, "en">,
  () => Promise<{ default: Locale }>
> = {
  fr: () => import("./fr"),
  es: () => import("./es"),
  "pt-BR": () => import("./pt-BR"),
  "zh-CN": () => import("./zh-CN"),
};

/** Locales already resolved in memory. `en` is always present (eager). */
const loaded: Partial<Record<SupportedLocale, Locale>> = { en };

/** Human-readable labels for the settings UI. */
export const localeLabels: Record<SupportedLocale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  "zh-CN": "简体中文",
};

export const supportedLocales = Object.keys(localeLabels) as SupportedLocale[];

export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Type guard — is `code` one of the supported locale codes? */
export function isSupportedLocale(code: string): code is SupportedLocale {
  return code in localeLabels;
}

/** Synchronously read an already-loaded locale, or `undefined` if not yet loaded. */
export function getLoadedLocale(code: SupportedLocale): Locale | undefined {
  return loaded[code];
}

/**
 * Resolve a locale's messages, caching the result. `en` resolves synchronously
 * (already in the main chunk); other locales fetch their chunk on first use.
 */
export async function loadLocale(code: SupportedLocale): Promise<Locale> {
  const existing = loaded[code];
  if (existing) return existing;
  const mod = await localeLoaders[code as Exclude<SupportedLocale, "en">]();
  loaded[code] = mod.default;
  return mod.default;
}

/**
 * Detect the best locale from the browser / OS language.
 *
 * Tries in order:
 *   1. Exact regional match (normalized): "zh-CN" → "zh-CN", "pt-BR" → "pt-BR".
 *   2. Primary-tag match: "fr-FR" → "fr", "es-MX" → "es".
 *   3. Fallback to DEFAULT_LOCALE.
 *
 * Regional codes are normalized to <lang-lower>-<region-upper> so that
 * "zh-cn" or "ZH-CN" both match the "zh-CN" key.
 */
export function detectLocale(): SupportedLocale {
  try {
    const raw = navigator.language;
    if (!raw) return DEFAULT_LOCALE;

    // 1. Try full regional tag, normalized ("zh-cn" -> "zh-CN")
    const [langRaw, regionRaw] = raw.split("-");
    if (langRaw && regionRaw) {
      const normalized = `${langRaw.toLowerCase()}-${regionRaw.toUpperCase()}`;
      if (isSupportedLocale(normalized)) return normalized;
    }

    // 2. Fall back to primary subtag ("fr-FR" -> "fr")
    const primary = langRaw?.toLowerCase();
    if (primary && isSupportedLocale(primary)) return primary;
  } catch {
    // SSR or no navigator
  }
  return DEFAULT_LOCALE;
}

export { type Locale, type LocaleKey } from "./en";
