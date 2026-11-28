import { describe, it, expect, afterEach, vi } from "vitest";
import { EXPLANATION_PARAMS } from "@gitwand/core";
import fr from "../../locales/explain/fr";
import es from "../../locales/explain/es";
import ptBR from "../../locales/explain/pt-BR";
import zhCN from "../../locales/explain/zh-CN";
import { useI18n } from "../../composables/useI18n";
import { hunkExplanation, loadExplanations } from "../hunkExplanation";

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
  const { setLocale } = useI18n();
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
    await loadExplanations("fr");
    expect(hunkExplanation(hunk)).toBe(
      "Bloc résolu sémantiquement par le résolveur « json » (fusion selon la structure du format, pas ligne à ligne).",
    );
  });

  it("substitutes the parameters in one pass", async () => {
    setLocale("fr");
    await loadExplanations("fr");
    expect(
      hunkExplanation({ explanation: "x", explanationRef: { key: "refactoringBoth", params: ["{1}", 2] } }),
    ).toContain("{1} renommage(s)");
  });

  it("loads the UI language's dictionary on the first explanation shown", async () => {
    setLocale("es");
    // English until the dictionary has arrived, then the translation.
    expect(hunkExplanation(hunk)).toBe(hunk.explanation);
    await vi.waitFor(() => expect(hunkExplanation(hunk)).toContain("resolvedor «json»"));
  });

  it("falls back to the English text without a known key", async () => {
    setLocale("fr");
    await loadExplanations("fr");
    expect(hunkExplanation({ explanation: "Some text." })).toBe("Some text.");
    expect(
      hunkExplanation({ explanation: "Some text.", explanationRef: { key: "notAKey" as never } }),
    ).toBe("Some text.");
  });
});
