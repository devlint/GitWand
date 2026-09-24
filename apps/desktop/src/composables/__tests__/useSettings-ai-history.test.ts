import { describe, it, expect, beforeEach } from "vitest";
import { loadSettings } from "../useSettings";
import en from "../../locales/en";
import fr from "../../locales/fr";
import es from "../../locales/es";
import ptBR from "../../locales/pt-BR";
import zhCN from "../../locales/zh-CN";

describe("v3.11.1 — AI history settings", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to enabled with a 1500-token budget", () => {
    const s = loadSettings();
    expect(s.aiHistoryEnabled).toBe(true);
    expect(s.aiHistoryBudgetTokens).toBe(1500);
  });

  it("has every new key in all five locales", () => {
    for (const loc of [en, fr, es, ptBR, zhCN]) {
      expect(Object.keys(loc.settings.aiHistory).sort()).toEqual(["budget", "budgetHint", "enabled", "enabledHint", "hint", "title"]);
      expect(Object.keys(loc.mergeEditor.llmResolution.history.reasons).sort()).toEqual(
        ["gitError", "locateFailed", "noCommits", "noMergeBase", "noSha", "sideDeleted", "timeout"],
      );
    }
  });
});
