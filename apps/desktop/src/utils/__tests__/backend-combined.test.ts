/**
 * `mapRawGitDiff` (shared by `getGitShow` and `getCombinedDiff`) and
 * `mapRawCombinedDiff`, the mapping of the Rust payload: serde emits the hunk
 * fields of `GitDiff` in snake_case, the combined types in camelCase. Pure
 * functions only — the transport (Tauri vs dev-server) is covered end to end
 * by the parity suite (`tests/parity/git-combined-diff.test.mjs`).
 */
import { describe, it, expect } from "vitest";
import { mapRawCombinedDiff, mapRawGitDiff } from "../backend";

const RAW_DIFF = {
  path: "b.txt",
  hunks: [
    {
      header: "@@ -1 +1 @@",
      old_start: 1,
      old_count: 1,
      new_start: 1,
      new_count: 1,
      lines: [
        { type: "delete", content: "x", old_line_no: 1, new_line_no: null },
        { type: "add", content: "y", old_line_no: null, new_line_no: 1 },
      ],
    },
  ],
  status: "renamed",
  oldPath: "a.txt",
};

const MAPPED = {
  path: "b.txt",
  hunks: [
    {
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        { type: "delete", content: "x", oldLineNo: 1, newLineNo: null },
        { type: "add", content: "y", oldLineNo: null, newLineNo: 1 },
      ],
    },
  ],
  status: "renamed",
  oldPath: "a.txt",
};

describe("mapRawGitDiff", () => {
  it("maps snake_case hunk fields to camelCase and keeps status/oldPath", () => {
    expect(mapRawGitDiff(RAW_DIFF)).toEqual(MAPPED);
  });

  it("keeps truncatedFromBytes", () => {
    const d = mapRawGitDiff({ path: "big", hunks: [], truncatedFromBytes: 6_000_000 });
    expect(d.truncatedFromBytes).toBe(6_000_000);
    expect(d.hunks).toEqual([]);
  });

  it("leaves truncatedFromBytes out when absent", () => {
    expect("truncatedFromBytes" in mapRawGitDiff(RAW_DIFF)).toBe(false);
  });
});

describe("mapRawCombinedDiff", () => {
  const commit = { hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "s", author: "me", date: "2024-01-01T00:00:00Z" };

  it("maps every GitDiff of the Rust payload", () => {
    const got = mapRawCombinedDiff({
      base: null,
      commits: [commit],
      diffs: [RAW_DIFF],
      steps: [[RAW_DIFF], []],
      fallback: [
        { path: "f", conflicted: true, perCommit: [{ hash: commit.hash, diff: RAW_DIFF }], blockers: ["b".repeat(40)] },
      ],
      truncated: true,
      budgetOmitted: [{ path: "f", commit: commit.hash }],
    });
    expect(got).toEqual({
      base: null,
      commits: [commit],
      diffs: [MAPPED],
      steps: [[MAPPED], []],
      fallback: [{ path: "f", conflicted: true, perCommit: [{ hash: commit.hash, diff: MAPPED }], blockers: ["b".repeat(40)] }],
      truncated: true,
      budgetOmitted: [{ path: "f", commit: commit.hash }],
    });
  });

  it("keeps base, companions and an untruncated payload as they are", () => {
    const got = mapRawCombinedDiff({
      base: "c".repeat(40),
      commits: [commit],
      diffs: [],
      steps: [[]],
      fallback: [{ path: "g", conflicted: false, perCommit: [], blockers: [] }],
      truncated: false,
      budgetOmitted: [],
    });
    expect(got).toEqual({
      base: "c".repeat(40),
      commits: [commit],
      diffs: [],
      steps: [[]],
      fallback: [{ path: "g", conflicted: false, perCommit: [], blockers: [] }],
      truncated: false,
      budgetOmitted: [],
    });
  });
});
