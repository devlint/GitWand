/**
 * prAiLocale.ts
 *
 * Maps a locale code to the language name used in AI system prompts. Shared
 * by every AI generator (commit message, PR description / summary /
 * pre-review, release notes, stash message, hunk explanation) so they can't
 * drift — previously each duplicated
 * a `locale === "fr" ? "French" : "English"` check that silently produced
 * English output for es/pt-BR/zh-CN users (verifier fix, v3.6.0).
 */
const AI_LANGUAGE_BY_LOCALE: Record<string, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  "pt-BR": "Brazilian Portuguese",
  "zh-CN": "Simplified Chinese",
  // Codes accepted by the older per-generator maps (output-language settings).
  de: "German", it: "Italian", pt: "Portuguese", ja: "Japanese", ko: "Korean",
  zh: "Chinese", nl: "Dutch", ru: "Russian", ar: "Arabic", pl: "Polish",
  sv: "Swedish", da: "Danish", nb: "Norwegian",
};

/** Falls back to English for an unrecognized or missing locale. */
export function localeToAiLanguage(locale: string | undefined): string {
  return (locale && AI_LANGUAGE_BY_LOCALE[locale]) ?? "English";
}
