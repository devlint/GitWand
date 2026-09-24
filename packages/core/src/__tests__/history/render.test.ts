import { describe, it, expect } from "vitest";
import { renderHistorySection, historyLabels, estimateTokens } from "../../history/render.js";
import type { HistoryCommit, HunkHistory } from "../../history/types.js";

const c = (n: number, extra: Partial<HistoryCommit> = {}): HistoryCommit => ({
  sha: String(n).repeat(40).slice(0, 40),
  author: `Author${n}`,
  date: `2026-09-0${n}`,
  subject: `subject ${n}`,
  body: `body ${n} `.repeat(20).trim(),
  rangeDiff: `@@ -1 +1 @@\n-old${n}\n+new${n}\n` + `+pad${n}\n`.repeat(30),
  ...extra,
});

const full: HunkHistory = {
  mergeBase: "f".repeat(40),
  ours: { status: "ok", commits: [c(1), c(2)] },
  theirs: { status: "ok", commits: [c(3), c(4)] },
};

describe("historyLabels", () => {
  it("names the theirs side after the operation head", () => {
    expect(historyLabels("merge")).toEqual({ ours: "ours (HEAD)", theirs: "theirs (MERGE_HEAD)" });
    expect(historyLabels("rebase").theirs).toBe("theirs (REBASE_HEAD)");
    expect(historyLabels("cherry-pick").theirs).toBe("theirs (CHERRY_PICK_HEAD)");
    expect(historyLabels("revert").theirs).toBe("theirs (REVERT_HEAD)");
    expect(historyLabels(undefined)).toEqual({ ours: "ours", theirs: "theirs" });
  });
});

describe("estimateTokens", () => {
  it("is ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("renderHistorySection", () => {
  it("includes everything when the budget allows", () => {
    const { text, stats } = renderHistorySection(full, 8000, historyLabels("merge"));
    expect(text).toContain("## Why each side changed these lines (since merge-base fffffff):");
    expect(text).toContain("### ours (HEAD)");
    expect(text).toContain("### theirs (MERGE_HEAD)");
    expect(text).toContain("- 1111111 2026-09-01 Author1: subject 1");
    expect(text).toContain("+new4");
    expect(stats).toEqual({ status: "included", reasons: [], commitCount: 4, estTokens: estimateTokens(text) });
  });

  it("drops diffs first, oldest first, keeping the newest diff per side longest", () => {
    const withAll = renderHistorySection(full, 8000).stats.estTokens;
    // Budget that forces dropping exactly the two oldest diffs (commits 2 and 4).
    const oneDiff = estimateTokens(c(1).rangeDiff) + 10;
    const { text, stats } = renderHistorySection(full, withAll - 2 * oneDiff + 20);
    expect(text).not.toContain("+new2");
    expect(text).not.toContain("+new4");
    expect(text).toContain("+new1");
    expect(text).toContain("+new3");
    expect(stats.status).toBe("truncated");
  });

  it("then drops bodies, then whole older commits, never the newest subject", () => {
    const { text, stats } = renderHistorySection(full, 1);
    expect(text).toContain("subject 1");
    expect(text).toContain("subject 3");
    expect(text).not.toContain("subject 2");
    expect(text).not.toContain("subject 4");
    expect(text).not.toContain("body 1");
    expect(text).not.toContain("+new1");
    expect(stats).toMatchObject({ status: "truncated", commitCount: 2 });
  });

  it("renders unavailable sides with their reason and reports status unavailable", () => {
    const h: HunkHistory = {
      mergeBase: null,
      ours: { status: "unavailable", reason: "no-merge-base", commits: [] },
      theirs: { status: "unavailable", reason: "no-merge-base", commits: [] },
    };
    const { text, stats } = renderHistorySection(h, 1500);
    expect(text).toContain("## Why each side changed these lines:");
    expect(text).toContain("History unavailable: the two sides share no merge base.");
    expect(stats).toEqual({ status: "unavailable", reasons: ["no-merge-base"], commitCount: 0, estTokens: estimateTokens(text) });
  });

  it("marks an ok side-deleted fallback as a removal", () => {
    const h: HunkHistory = {
      mergeBase: "f".repeat(40),
      ours: { status: "ok", reason: "side-deleted", commits: [c(1, { rangeDiff: "" })] },
      theirs: { status: "unavailable", reason: "no-commits", commits: [] },
    };
    const { text, stats } = renderHistorySection(h, 1500);
    expect(text).toContain("This side removed these lines. Commits that touched the file:");
    expect(text).toContain("History unavailable: no commit changed these lines since the merge base.");
    expect(stats.status).toBe("included");
    expect(stats.reasons).toEqual(["side-deleted", "no-commits"]);
  });

  it("picks a diff fence longer than any backtick run in the diff", () => {
    const md = "@@ -1,3 +1,3 @@\n ```js\n-old\n+new\n ```";
    const h: HunkHistory = {
      mergeBase: "f".repeat(40),
      ours: { status: "ok", commits: [c(1, { rangeDiff: md })] },
      theirs: { status: "ok", commits: [c(3, { rangeDiff: "@@ -1 +1 @@\n-a\n+b" })] },
    };
    const { text } = renderHistorySection(h, 8000);
    expect(text).toContain("  ````diff\n");
    expect(text).toContain("\n  ````\n");
    // A diff without backticks keeps the usual three.
    expect(text).toContain("  ```diff\n  @@ -1 +1 @@");
  });
});
