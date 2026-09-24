import { describe, it, expect } from "vitest";
import { parseLog, isPureMove, LOG_FORMAT } from "../../history/parse.js";
import {
  clampHistoryBudget,
  normalizeHistoryConfig,
  historyRefsFromMergeContext,
  DEFAULT_HISTORY_CONFIG,
} from "../../history/types.js";

const RS = "\x1e";
const US = "\x1f";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

// Shape captured from `git log -L 2,2:f.txt <range> --format=<LOG_FORMAT>` (git 2.50).
const LOG_L_OUTPUT =
  `${RS}${SHA1}${US}Alice${US}2026-09-10${US}theirs change${US}body line1\n\nbody line3\n${US}\n\n` +
  `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B-theirs\n\n` +
  `${RS}${SHA2}${US}Bob${US}2026-09-01${US}earlier${US}${US}\n\n` +
  `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-x\n+b\n`;

describe("LOG_FORMAT", () => {
  it("uses record and unit separators", () => {
    expect(LOG_FORMAT).toBe("%x1e%H%x1f%an%x1f%as%x1f%s%x1f%b%x1f");
  });
});

describe("parseLog", () => {
  it("parses commits with bodies and range diffs, newest first", () => {
    const commits = parseLog(LOG_L_OUTPUT);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: SHA1,
      author: "Alice",
      date: "2026-09-10",
      subject: "theirs change",
      body: "body line1\n\nbody line3",
      rangeDiff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B-theirs",
    });
    expect(commits[1].body).toBe("");
    expect(commits[1].subject).toBe("earlier");
  });

  it("parses a patch-free file-level log", () => {
    const out = `${RS}${SHA1}${US}Alice${US}2026-09-10${US}remove block${US}${US}\n`;
    expect(parseLog(out)).toEqual([
      { sha: SHA1, author: "Alice", date: "2026-09-10", subject: "remove block", body: "", rangeDiff: "" },
    ]);
  });

  it("returns [] on empty or garbage output", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("fatal: something")).toEqual([]);
    expect(parseLog(`${RS}not-a-sha${US}x${US}y${US}z${US}${US}`)).toEqual([]);
  });
});

describe("isPureMove", () => {
  it("is true when removed and added lines are the same multiset (whitespace-insensitive)", () => {
    const diff = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-foo()\n-bar()\n+  bar()\n+  foo()";
    expect(isPureMove(diff)).toBe(true);
  });
  it("is false for a real edit", () => {
    expect(isPureMove("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-foo()\n+foo(1)")).toBe(false);
  });
  it("is false for pure additions (file creation)", () => {
    expect(isPureMove("--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+foo()")).toBe(false);
  });
  it("is false for an empty diff", () => {
    expect(isPureMove("")).toBe(false);
  });
});

describe("history config helpers", () => {
  it("clamps the budget to 200..8000", () => {
    expect(clampHistoryBudget(10)).toBe(200);
    expect(clampHistoryBudget(99999)).toBe(8000);
    expect(clampHistoryBudget(1500.7)).toBe(1501);
    expect(clampHistoryBudget(Number.NaN)).toBe(DEFAULT_HISTORY_CONFIG.budgetTokens);
  });
  it("normalizes a raw .gitwandrc history block", () => {
    expect(normalizeHistoryConfig({ enabled: false, budgetTokens: 50 })).toEqual({ enabled: false, budgetTokens: 200 });
    expect(normalizeHistoryConfig({ enabled: "yes" })).toBeUndefined();
    expect(normalizeHistoryConfig(null)).toBeUndefined();
    expect(normalizeHistoryConfig({ budgetTokens: 3000 })).toEqual({ budgetTokens: 3000 });
  });
  it("extracts refs from a MergeContext", () => {
    expect(historyRefsFromMergeContext(null)).toEqual({});
    expect(
      historyRefsFromMergeContext({ operation: "cherry-pick", targetSide: "ours", oursSha: "o", theirsSha: "t" }),
    ).toEqual({ operation: "cherry-pick", oursSha: "o", theirsSha: "t" });
  });
});
