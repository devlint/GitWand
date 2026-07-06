import { describe, it, expect } from "vitest";
import type { ConflictType, DecisionTrace, TokenMergeTrace } from "../types.js";

describe("types : token_level_merge", () => {
  it("ConflictType accepte 'token_level_merge'", () => {
    const t: ConflictType = "token_level_merge";
    expect(t).toBe("token_level_merge");
  });

  it("DecisionTrace peut porter un tokenMergeTrace optionnel", () => {
    const trace: DecisionTrace = {
      steps: [],
      selected: "token_level_merge",
      summary: "test",
      hasBase: true,
      tokenMergeTrace: {
        mergedLines: ["a", "b"],
        pass1Count: 1,
        pass2Count: 1,
        lineDetails: [
          { lineIndex: 0, resolvedBy: "pass1", resolvedLine: "a" },
          { lineIndex: 1, resolvedBy: "pass2", resolvedLine: "b" },
        ],
      },
    };
    expect(trace.tokenMergeTrace?.mergedLines).toEqual(["a", "b"]);
  });
});
