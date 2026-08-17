/**
 * Task 4 (v3.7.0) — `commitReviewState.ts`: content-hash-based coverage
 * tracking + review-iteration counting, persisted to localStorage keyed by
 * repo (pattern: `usePrCache.ts`). Pure functions get hand-built inputs and
 * no mocks; the store itself is exercised against real (jsdom) localStorage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { GitDiff } from "../../utils/backend";

let mod: typeof import("../commitReviewState");

beforeEach(async () => {
  localStorage.clear();
  mod = await import("../commitReviewState");
  mod._resetCommitReviewStateForTesting();
});

function diffWithAddedLines(path: string, added: string[]): GitDiff {
  return {
    path,
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@",
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: added.length + 1,
        lines: [
          { type: "context", content: "unchanged", oldLineNo: 1, newLineNo: 1 },
          ...added.map((content, i) => ({ type: "add" as const, content, newLineNo: i + 2 })),
        ],
      },
    ],
  };
}

describe("hashLineKey", () => {
  it("is stable for the same path+content", () => {
    expect(mod.hashLineKey("a.ts", "foo")).toBe(mod.hashLineKey("a.ts", "foo"));
  });

  it("gives distinct keys for identical content in two different files", () => {
    expect(mod.hashLineKey("a.ts", "same line")).not.toBe(mod.hashLineKey("b.ts", "same line"));
  });

  it("gives distinct keys for different content in the same file", () => {
    expect(mod.hashLineKey("a.ts", "foo")).not.toBe(mod.hashLineKey("a.ts", "bar"));
  });
});

describe("addedLineKeys", () => {
  it("only counts added lines — context and delete lines are ignored", () => {
    const file: GitDiff = {
      path: "a.ts",
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@",
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: "context", content: "ctx", oldLineNo: 1, newLineNo: 1 },
            { type: "delete", content: "removed", oldLineNo: 2 },
            { type: "add", content: "added", newLineNo: 2 },
          ],
        },
      ],
    };
    const keys = mod.addedLineKeys([file]);
    expect(keys).toEqual([mod.hashLineKey("a.ts", "added")]);
  });

  it("aggregates across multiple files", () => {
    const keys = mod.addedLineKeys([
      diffWithAddedLines("a.ts", ["x"]),
      diffWithAddedLines("b.ts", ["y"]),
    ]);
    expect(keys.sort()).toEqual(
      [mod.hashLineKey("a.ts", "x"), mod.hashLineKey("b.ts", "y")].sort(),
    );
  });
});

describe("computeCoverage", () => {
  it("returns 100 when there are no current added lines", () => {
    expect(mod.computeCoverage([], new Set(["x"]))).toBe(100);
  });

  it("returns 0 when nothing current has been reviewed", () => {
    expect(mod.computeCoverage(["a", "b"], new Set())).toBe(0);
  });

  it("rounds a partial overlap (2/3 -> 67)", () => {
    expect(mod.computeCoverage(["a", "b", "c"], new Set(["a", "b"]))).toBe(67);
  });

  it("returns 100 on a full overlap", () => {
    expect(mod.computeCoverage(["a", "b"], new Set(["a", "b", "z"]))).toBe(100);
  });

  it("is stable when line numbers shift but content doesn't (same hash keys)", () => {
    const before = mod.addedLineKeys([diffWithAddedLines("a.ts", ["same content"])]);
    // Same content, different line position in the hunk — the hash is
    // content-based, so this must be treated as already-reviewed.
    const after = mod.addedLineKeys([
      { ...diffWithAddedLines("a.ts", ["same content"]), hunks: [{ ...diffWithAddedLines("a.ts", ["same content"]).hunks[0], newStart: 50 }] },
    ]);
    expect(mod.computeCoverage(after, new Set(before))).toBe(100);
  });
});

describe("recordReview / getState / coverageFor / clear", () => {
  it("recordReview increments iterations and coverageFor reflects the reviewed lines", () => {
    const files = [diffWithAddedLines("a.ts", ["line1"])];
    mod.recordReview("/repo", files);
    expect(mod.getState("/repo").iterations).toBe(1);
    expect(mod.coverageFor("/repo", files)).toBe(100);

    mod.recordReview("/repo", files);
    expect(mod.getState("/repo").iterations).toBe(2);
  });

  it("coverageFor drops below 100 when a new unreviewed line is added", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["line1"])]);
    const expanded = [diffWithAddedLines("a.ts", ["line1", "line2"])];
    expect(mod.coverageFor("/repo", expanded)).toBe(50);
  });

  it("getState for an unknown repo returns iterations 0 and no snapshots", () => {
    const st = mod.getState("/never-reviewed");
    expect(st.iterations).toBe(0);
    expect(st.snapshots).toEqual([]);
  });

  it("evicts the oldest snapshot once MAX_SNAPSHOTS is exceeded", () => {
    for (let i = 0; i < mod.MAX_SNAPSHOTS + 3; i++) {
      mod.recordReview("/repo", [diffWithAddedLines("a.ts", [`line-${i}`])]);
    }
    const st = mod.getState("/repo");
    expect(st.snapshots.length).toBe(mod.MAX_SNAPSHOTS);
    // The earliest snapshots' hashes must be gone from the reviewed union.
    const reviewed = mod.reviewedHashesFor("/repo");
    expect(reviewed.has(mod.hashLineKey("a.ts", "line-0"))).toBe(false);
    // The most recent one must still be present.
    const lastIdx = mod.MAX_SNAPSHOTS + 2;
    expect(reviewed.has(mod.hashLineKey("a.ts", `line-${lastIdx}`))).toBe(true);
  });

  it("truncates a single snapshot's hashes at MAX_HASHES", () => {
    const manyLines = Array.from({ length: mod.MAX_HASHES + 500 }, (_, i) => `l${i}`);
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", manyLines)]);
    const raw = JSON.parse(localStorage.getItem(mod.COMMIT_REVIEW_STATE_STORAGE_KEY)!);
    const snap = raw.repos["/repo"].snapshots[0];
    expect(snap.lineHashes.length).toBe(mod.MAX_HASHES);
  });

  it("loads a corrupt localStorage payload as empty state instead of throwing", () => {
    localStorage.setItem(mod.COMMIT_REVIEW_STATE_STORAGE_KEY, "{not json");
    mod._resetCommitReviewStateForTesting();
    expect(() => mod.getState("/repo")).not.toThrow();
    expect(mod.getState("/repo").iterations).toBe(0);
  });

  it("drops snapshots older than 7 days on load", () => {
    const stale = {
      repos: {
        "/repo": {
          iterations: 3,
          updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
          snapshots: [
            { iter: 1, ts: Date.now() - 10 * 24 * 60 * 60 * 1000, lineHashes: ["stale-hash"] },
          ],
        },
      },
    };
    localStorage.setItem(mod.COMMIT_REVIEW_STATE_STORAGE_KEY, JSON.stringify(stale));
    mod._resetCommitReviewStateForTesting();
    expect(mod.reviewedHashesFor("/repo").size).toBe(0);
  });

  it("clear removes only the target repo's entry", () => {
    mod.recordReview("/repo-a", [diffWithAddedLines("a.ts", ["x"])]);
    mod.recordReview("/repo-b", [diffWithAddedLines("b.ts", ["y"])]);
    mod.clear("/repo-a");
    expect(mod.getState("/repo-a").iterations).toBe(0);
    expect(mod.getState("/repo-b").iterations).toBe(1);
  });

  it("persists across a module reset (survives a simulated app restart)", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["line1"])]);
    mod._resetCommitReviewStateForTesting();
    expect(mod.getState("/repo").iterations).toBe(1);
  });
});
