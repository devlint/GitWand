import { describe, it, expect, vi, afterEach } from "vitest";
import { EXPLANATION_PARAMS } from "@gitwand/core";
import en from "../../locales/en";
import fr from "../../locales/explain/fr";
import es from "../../locales/explain/es";
import ptBR from "../../locales/explain/pt-BR";
import zhCN from "../../locales/explain/zh-CN";
import { useI18n } from "../../composables/useI18n";
import { hunkExplanation } from "../hunkExplanation";

const DICTIONARIES = { fr, es, "pt-BR": ptBR, "zh-CN": zhCN } as const;

describe("explanation dictionaries", () => {
  for (const [code, explain] of Object.entries(DICTIONARIES)) {
    it(`${code} has every explanation key, with exactly its parameters`, () => {
      for (const [key, count] of Object.entries(EXPLANATION_PARAMS)) {
        const text = (explain as Record<string, string>)[key];
        expect(text, `${code} explain.${key}`).toBeTypeOf("string");
        const used = new Set([...text.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])));
        expect([...used].sort(), `${code} explain.${key}`).toEqual([...Array(count).keys()]);
      }
    });
  }
});

describe("hunkExplanation", () => {
  const { setLocale, t } = useI18n();
  const hunk = {
    explanation: 'Hunk resolved semantically by the "json" resolver (merged by the format\'s structure, not by lines).',
    explanationRef: { key: "formatSemantic" as const, params: ["json"] },
  };

  afterEach(() => setLocale("en"));

  it("shows core's own text under the English UI", () => {
    setLocale("en");
    expect(hunkExplanation(hunk)).toBe(hunk.explanation);
  });

  it("shows the translation, with its parameters, under another UI language", async () => {
    setLocale("fr");
    await vi.waitFor(() => expect(t("common.cancel")).not.toBe(en.common.cancel));
    expect(hunkExplanation(hunk)).toBe(
      "Bloc résolu sémantiquement par le résolveur « json » (fusion selon la structure du format, pas ligne à ligne).",
    );
  });

  it("falls back to the English text without a known key", async () => {
    setLocale("fr");
    await vi.waitFor(() => expect(t("common.cancel")).not.toBe(en.common.cancel));
    expect(hunkExplanation({ explanation: "Some text." })).toBe("Some text.");
    expect(
      hunkExplanation({ explanation: "Some text.", explanationRef: { key: "notAKey" as never } }),
    ).toBe("Some text.");
  });
});
