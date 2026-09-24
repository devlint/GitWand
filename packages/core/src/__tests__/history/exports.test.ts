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
  it("defaults gitRunner to null", () => {
    expect(DEFAULT_OPTIONS.gitRunner).toBeNull();
  });
});
