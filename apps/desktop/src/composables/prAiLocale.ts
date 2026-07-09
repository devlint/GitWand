/**
 * prAiLocale.ts
 *
 * Maps a product `SupportedLocale` to the language name used in AI system
 * prompts (pre-review findings, PR summary). Shared by `usePrPreReview.ts`
 * and `usePrSummary.ts` so the two can't drift — previously each duplicated
 * a `locale === "fr" ? "French" : "English"` check that silently produced
 * English output for es/pt-BR/zh-CN users (verifier fix, v3.6.0).
 */
const AI_LANGUAGE_BY_LOCALE: Record<string, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  "pt-BR": "Brazilian Portuguese",
  "zh-CN": "Simplified Chinese",
};

/** Falls back to English for an unrecognized or missing locale. */
export function localeToAiLanguage(locale: string | undefined): string {
  return (locale && AI_LANGUAGE_BY_LOCALE[locale]) ?? "English";
}
