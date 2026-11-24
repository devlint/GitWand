/**
 * useCombinedSummary — user prompt carries subjects + per-file counts only
 * (never hunk text), errors surface, `available` mirrors the provider.
 * Fakes are injected; nothing is mocked.
 */
import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { useCombinedSummary, buildCombinedUserPrompt } from "../useCombinedSummary";
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
  steps: [], fallback: [], truncated: false, ...over,
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

describe("useCombinedSummary", () => {
  it("sends the system + user prompts and stores the trimmed result", async () => {
    const calls: [string, string][] = [];
    const s = useCombinedSummary({ rawPrompt: async (a, b) => { calls.push([a, b]); return "  done \n"; }, isAvailable: ref(true) });
    await s.generate(data(), "fr");
    expect(s.summary.value).toBe("done");
    expect(s.error.value).toBeNull();
    expect(s.loading.value).toBe(false);
    expect(calls[0][0]).toContain("French");
    expect(calls[0][1]).not.toContain(SECRET);
  });
  it("sets error on provider failure and keeps no summary", async () => {
    const s = useCombinedSummary({ rawPrompt: async () => { throw new Error("boom"); }, isAvailable: ref(true) });
    await s.generate(data(), "en");
    expect(s.error.value).toBe("boom");
    expect(s.summary.value).toBeNull();
    expect(s.loading.value).toBe(false);
  });
  it("available mirrors isAvailable", () => {
    const av = ref(false);
    const s = useCombinedSummary({ rawPrompt: async () => "", isAvailable: av });
    expect(s.available.value).toBe(false);
    av.value = true;
    expect(s.available.value).toBe(true);
  });

  it("reset drops a late result and releases loading for a new generate", async () => {
    const pending: ((v: string) => void)[] = [];
    const s = useCombinedSummary({ rawPrompt: () => new Promise<string>((r) => { pending.push(r); }), isAvailable: ref(true) });
    const first = s.generate(data(), "en");
    s.reset();
    expect(s.loading.value).toBe(false);
    const second = s.generate(data(), "en");
    pending[0]("old");
    await first;
    expect(s.summary.value).toBeNull();
    expect(s.loading.value).toBe(true);
    pending[1]("new");
    await second;
    expect(s.summary.value).toBe("new");
    expect(s.loading.value).toBe(false);
  });
  it("reset clears an earlier error", async () => {
    const s = useCombinedSummary({ rawPrompt: async () => { throw new Error("boom"); }, isAvailable: ref(true) });
    await s.generate(data(), "en");
    s.reset();
    expect(s.error.value).toBeNull();
  });
});
