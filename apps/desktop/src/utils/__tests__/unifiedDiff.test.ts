/**
 * Task 0 (v3.7.0) — `indexDiffFiles` / `parseFileDiff` / `parseUnifiedDiff` lifted
 * out of `usePrPanel.ts` into a pure, Vue-free, backend-free module so a
 * commit-review composable never has to import the PR panel to parse a diff.
 *
 * These three assertions are copied from `usePrPanel-lazy-diff.test.ts` — the
 * blank-context-line one is the diff-parsing gotcha guard (AGENTS.md): an
 * empty string is a context line, never a phantom add/delete.
 */
import { describe, it, expect } from "vitest";
import { indexDiffFiles, parseFileDiff, parseUnifiedDiff } from "../unifiedDiff";

const THREE_FILE_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " context a",
  "-old a",
  "+new a",
  "diff --git a/b.ts b/b.ts",
  "index 333..444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,3 +1,3 @@",
  " context b",
  "",
  "-old b",
  "+new b",
  "diff --git a/c.ts b/c.ts",
  "index 555..666 100644",
  "--- a/c.ts",
  "+++ b/c.ts",
  "@@ -1,1 +1,1 @@",
  "-old c",
  "+new c",
].join("\n");

describe("indexDiffFiles", () => {
  it("splits a raw multi-file diff into per-file slices with correct b/ paths", () => {
    const slices = indexDiffFiles(THREE_FILE_DIFF);
    expect(slices.map((s) => s.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    for (const s of slices) {
      expect(s.raw.startsWith(`diff --git a/${s.path} b/${s.path}`)).toBe(true);
    }
  });

  it("returns [] for an empty diff", () => {
    expect(indexDiffFiles("")).toEqual([]);
    expect(indexDiffFiles("   ")).toEqual([]);
  });
});

describe("parseFileDiff", () => {
  it("matches parseUnifiedDiff's per-file output (regression parity)", () => {
    const expected = parseUnifiedDiff(THREE_FILE_DIFF);
    const slices = indexDiffFiles(THREE_FILE_DIFF);
    const actual = slices.map((s) => parseFileDiff(s.raw));
    expect(actual).toEqual(expected);
  });

  it("classifies an empty-string context line as context, not add/delete", () => {
    const slice = indexDiffFiles(THREE_FILE_DIFF)[1]; // b.ts has a blank context line
    const parsed = parseFileDiff(slice.raw);
    const blank = parsed.hunks[0].lines.find((l) => l.content === "" && l.type !== undefined);
    expect(blank?.type).toBe("context");
  });
});
