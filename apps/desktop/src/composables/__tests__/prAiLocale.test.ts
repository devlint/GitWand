/**
 * prAiLocale — verifier fix (v3.6.0): the AI pre-review/summary system
 * prompts only mapped locale === "fr" ? "French" : "English", so es/pt-BR/
 * zh-CN users silently got English-language findings and summaries. Shared
 * helper so `usePrPreReview.ts` and `usePrSummary.ts` can't drift.
 */
import { describe, it, expect } from "vitest";
import { localeToAiLanguage } from "../prAiLocale";

describe("localeToAiLanguage", () => {
  it("maps all 5 product locales to their AI prompt language name", () => {
    expect(localeToAiLanguage("en")).toBe("English");
    expect(localeToAiLanguage("fr")).toBe("French");
    expect(localeToAiLanguage("es")).toBe("Spanish");
    expect(localeToAiLanguage("pt-BR")).toBe("Brazilian Portuguese");
    expect(localeToAiLanguage("zh-CN")).toBe("Simplified Chinese");
  });

  it("falls back to English for an unrecognized locale", () => {
    expect(localeToAiLanguage("xx")).toBe("English");
    expect(localeToAiLanguage(undefined)).toBe("English");
  });
});
