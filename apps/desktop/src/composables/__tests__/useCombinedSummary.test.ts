/**
 * useCombinedSummary's prompts — the user prompt carries subjects + per-file
 * counts only (never hunk text). Stale replies are `latestOnly`'s
 * (utils/__tests__/latestOnly.test.ts); the provider call is not faked.
 */
import { describe, it, expect } from "vitest";
import { buildCombinedSystemPrompt, buildCombinedUserPrompt } from "../useCombinedSummary";
import { buildSummaryPrompt, buildSummaryPromptFromCounts } from "../usePrSummary";
import type { CombinedDiff, GitDiff } from "../../utils/backend";

const SECRET = "SECRET_HUNK_TEXT_42";
const diff = (path: string, adds: number, dels: number, extra: Partial<GitDiff> = {}): GitDiff => ({
  path,
  hunks: adds + dels === 0 ? [] : [{
    header: "@@", oldStart: 1, oldCount: dels, newStart: 1, newCount: adds,
    lines: [
      ...Array.from({ length: dels }, (_, i) => ({ type: "delete" as const, content: SECRET, oldLineNo: i + 1 })),
      ...Array.from({ length: adds }, (_, i) => ({ type: "add" as const, content: SECRET, newLineNo: i + 1 })),
    ],
  }],
  ...extra,
});
const commits = ["one", "two"].map((subject, i) => ({
  hash: String(i).repeat(40), shortHash: String(i).repeat(7), subject, author: "a", date: "d",
}));
const data = (over: Partial<CombinedDiff> = {}): CombinedDiff => ({
  base: "b", commits, diffs: [diff("a.ts", 3, 1), diff("big.bin", 0, 0, { truncatedFromBytes: 9_000_000 })],
  steps: [], fallback: [], truncated: false, budgetOmitted: [], ...over,
});

describe("buildSummaryPromptFromCounts", () => {
  it("matches buildSummaryPrompt for equivalent input", () => {
    const raw = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n";
    expect(buildSummaryPromptFromCounts([{ path: "x", added: 2, deleted: 1 }], ["t1", "t2"]))
      .toBe(buildSummaryPrompt([{ path: "x", raw }], ["t1", "t2"]));
  });
});

describe("buildCombinedUserPrompt", () => {
  it("lists subjects and path (+a/-d), no hunk content", () => {
    const p = buildCombinedUserPrompt(data());
    expect(p).toContain("- one");
    expect(p).toContain("- two");
    expect(p).toContain("a.ts (+3/-1)");
    expect(p).toContain("big.bin (+0/-0)");
    expect(p).not.toContain(SECRET);
  });
  it("includes fallback per-commit diffs, summed by path", () => {
    const p = buildCombinedUserPrompt(data({
      fallback: [{ path: "f.ts", conflicted: true, blockers: [], perCommit: [
        { hash: commits[0].hash, diff: diff("f.ts", 2, 0) },
        { hash: commits[1].hash, diff: diff("f.ts", 1, 1) },
      ] }],
    }));
    expect(p).toContain("f.ts (+3/-1)");
    expect(p).not.toContain(SECRET);
  });
});

describe("buildCombinedSystemPrompt", () => {
  it("asks for the user's language and names the commit count", () => {
    const p = buildCombinedSystemPrompt("fr", 3);
    expect(p).toContain("French");
    expect(p).toContain("3 commits");
  });
});
