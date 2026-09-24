import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "../useAIProvider";

describe("buildUserPrompt — v3.11.1 history", () => {
  const base = { filePath: "f.ts", base: "b", ours: "o", theirs: "t" };

  it("puts the history section before the three versions", () => {
    const p = buildUserPrompt({ ...base, history: "## Why each side changed these lines:\n### ours\n- abc1234 2026-09-01 A: s" });
    expect(p).toContain("## Why each side changed these lines:");
    expect(p.indexOf("## Why each side")).toBeLessThan(p.indexOf("--- BASE"));
  });

  it("is unchanged without history", () => {
    expect(buildUserPrompt(base)).toBe(
      "File: f.ts\n\n--- BASE (common ancestor) ---\nb\n\n--- OURS (current branch) ---\no\n\n--- THEIRS (incoming branch) ---\nt\n\nResolve this conflict. Return JSON only.",
    );
  });
});
