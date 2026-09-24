import { describe, it, expect } from "vitest";
import * as core from "../../index.js";
import { DEFAULT_OPTIONS } from "../../resolver/policy.js";

describe("v3.11.1 public surface", () => {
  it("exports the history API from @gitwand/core", () => {
    for (const name of [
      "collectHunkHistory", "createHistoryCache", "renderHistorySection", "historyLabels",
      "normalizeHistoryConfig", "clampHistoryBudget", "historyRefsFromMergeContext", "DEFAULT_HISTORY_CONFIG",
    ]) {
      expect(core).toHaveProperty(name);
    }
  });
  it("freezes the shared history defaults", () => {
    expect(Object.isFrozen(core.DEFAULT_HISTORY_CONFIG)).toBe(true);
    expect(Object.isFrozen(core.DISABLED_HISTORY_STATS)).toBe(true);
    expect(Object.isFrozen(core.DISABLED_HISTORY_STATS.reasons)).toBe(true);
  });
  it("defaults gitRunner to null", () => {
    expect(DEFAULT_OPTIONS.gitRunner).toBeNull();
  });
});
