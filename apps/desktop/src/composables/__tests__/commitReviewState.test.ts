/**
 * Task 4 (v3.7.0) — `commitReviewState.ts`: content-hash-based coverage
 * tracking + review-iteration counting, persisted to localStorage keyed by
 * repo (pattern: `usePrCache.ts`). Pure functions get hand-built inputs and
 * no mocks; the store itself is exercised against real (jsdom) localStorage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GitDiff } from "../../utils/backend";

let mod: typeof import("../commitReviewState");

/**
 * Regression guard: this module's source once had a raw, literal NUL byte
 * embedded in a template literal (instead of the `\0` escape sequence),
 * which made the whole file register as binary to git — GitHub rendered it
 * as "Binary file not shown", and git blame/diff broke on it going forward.
 * A NUL byte is never valid in this source file; this test fails loudly if
 * one silently reappears, in this file or any sibling `.ts` source that
 * might copy the same pattern.
 */
describe("source file encoding", () => {
  it("commitReviewState.ts contains no raw NUL byte", () => {
    // `node:path` join (not `new URL(relative, import.meta.url)`) — jsdom's
    // shimmed global `URL` isn't accepted by `fileURLToPath`'s scheme check.
    const testDir = dirname(fileURLToPath(import.meta.url));
    const path = join(testDir, "..", "commitReviewState.ts");
    const raw = readFileSync(path);
    expect(raw.includes(0)).toBe(false);
  });
});

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

  // ── Verifier item #3 — a stale iterations count must never survive past
  // the evidence (snapshots) that justified it aging out. Without this, a
  // repo can end up with {iterations: 3, snapshots: []} and the next commit
  // silently records "ran (iter:3, coverage:0%)" with no review having
  // actually happened and no decision modal shown.
  it("resets iterations to 0 when pruning empties the snapshot list on load", () => {
    const stale = {
      repos: {
        "/repo": {
          iterations: 3,
          updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
          headHash: "abc123",
          snapshots: [
            { iter: 1, ts: Date.now() - 10 * 24 * 60 * 60 * 1000, lineHashes: ["stale-hash"] },
          ],
        },
      },
    };
    localStorage.setItem(mod.COMMIT_REVIEW_STATE_STORAGE_KEY, JSON.stringify(stale));
    mod._resetCommitReviewStateForTesting();
    expect(mod.getState("/repo").iterations).toBe(0);
  });

  it("does NOT reset iterations when pruning only removes SOME snapshots, leaving others", () => {
    const now = Date.now();
    const state = {
      repos: {
        "/repo": {
          iterations: 2,
          updatedAt: now,
          headHash: "abc123",
          snapshots: [
            { iter: 1, ts: now - 10 * 24 * 60 * 60 * 1000, lineHashes: ["old-hash"] }, // stale, pruned
            { iter: 2, ts: now, lineHashes: ["fresh-hash"] }, // still fresh
          ],
        },
      },
    };
    localStorage.setItem(mod.COMMIT_REVIEW_STATE_STORAGE_KEY, JSON.stringify(state));
    mod._resetCommitReviewStateForTesting();
    expect(mod.getState("/repo").iterations).toBe(2);
    expect(mod.reviewedHashesFor("/repo").has("fresh-hash")).toBe(true);
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

// ── Verifier item #3 — bind the review cycle to HEAD ───────────────────────
// `iterations` must not survive a commit made OUTSIDE `proceedToCommit`
// (amend, a terminal commit, any external tool): without this, the count
// leaks across commits and the next in-app commit can silently write a
// `GitWand-Review: ran (iter:N, ...)` trailer with no review having actually
// happened against the diff that's about to be committed.
describe("recordReview HEAD-cycle binding", () => {
  it("recordReview stamps the given headHash on the state", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["x"])], "sha-1");
    expect(mod.getState("/repo").headHash).toBe("sha-1");
  });

  it("recordReview starts a fresh cycle (iterations back to 1) when headHash differs from what's recorded", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["x"])], "sha-1");
    expect(mod.getState("/repo").iterations).toBe(1);

    // Same HEAD — a normal second review pass in the same cycle.
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["y"])], "sha-1");
    expect(mod.getState("/repo").iterations).toBe(2);

    // HEAD changed (a commit happened) — the next review starts a NEW cycle.
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["z"])], "sha-2");
    expect(mod.getState("/repo").iterations).toBe(1);
  });

  it("does not reset the cycle when no headHash is provided (back-compat default)", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["x"])], "sha-1");
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["y"])]); // no third arg
    expect(mod.getState("/repo").iterations).toBe(2);
  });
});

describe("reconcileHead", () => {
  it("resets iterations/snapshots to a fresh cycle when the stored headHash differs from the current one", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["x"])], "sha-1");
    expect(mod.getState("/repo").iterations).toBe(1);

    const next = mod.reconcileHead("/repo", "sha-2");
    expect(next.iterations).toBe(0);
    expect(next.snapshots).toEqual([]);
    expect(next.headHash).toBe("sha-2");
    expect(mod.getState("/repo").iterations).toBe(0);
  });

  it("is a no-op (just stamps headHash) when nothing was recorded yet for this repo", () => {
    const next = mod.reconcileHead("/never-reviewed", "sha-1");
    expect(next.iterations).toBe(0);
    expect(next.headHash).toBe("sha-1");
  });

  it("leaves iterations/snapshots untouched when the headHash is unchanged", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["x"])], "sha-1");
    const next = mod.reconcileHead("/repo", "sha-1");
    expect(next.iterations).toBe(1);
  });

  it("leaves state unchanged when the current headHash can't be resolved (empty string)", () => {
    mod.recordReview("/repo", [diffWithAddedLines("a.ts", ["x"])], "sha-1");
    const next = mod.reconcileHead("/repo", "");
    expect(next.iterations).toBe(1);
    expect(next.headHash).toBe("sha-1");
  });
});

// ── Task 5 (v3.7.0) — GitWand-Review trailer + commit gate ────────────────
describe("buildReviewTrailer", () => {
  it("builds the exact ran/iter/coverage shape", () => {
    expect(mod.buildReviewTrailer("ran", 2, 87)).toBe("GitWand-Review: ran (iter:2, coverage:87%)");
  });

  it("builds vouched and skipped the same way when iter > 0", () => {
    expect(mod.buildReviewTrailer("vouched", 1, 50)).toBe("GitWand-Review: vouched (iter:1, coverage:50%)");
    expect(mod.buildReviewTrailer("skipped", 3, 10)).toBe("GitWand-Review: skipped (iter:3, coverage:10%)");
  });

  it("omits the parenthetical entirely when iter is 0 (decision D9)", () => {
    expect(mod.buildReviewTrailer("skipped", 0, 0)).toBe("GitWand-Review: skipped");
    expect(mod.buildReviewTrailer("vouched", 0, 42)).toBe("GitWand-Review: vouched");
  });

  it("clamps coverage to 0-100", () => {
    expect(mod.buildReviewTrailer("ran", 1, 150)).toBe("GitWand-Review: ran (iter:1, coverage:100%)");
    expect(mod.buildReviewTrailer("ran", 1, -20)).toBe("GitWand-Review: ran (iter:1, coverage:0%)");
  });

  it("floors a negative iter at 0 (which also drops the parenthetical)", () => {
    expect(mod.buildReviewTrailer("ran", -5, 80)).toBe("GitWand-Review: ran");
  });

  it("has no trailing newline", () => {
    expect(mod.buildReviewTrailer("ran", 1, 100).endsWith("\n")).toBe(false);
  });

  it("the key is exactly 'GitWand-Review' when parsed by the first colon (git interpret-trailers semantics)", () => {
    const trailer = mod.buildReviewTrailer("ran", 2, 87);
    const firstColon = trailer.indexOf(":");
    const key = trailer.slice(0, firstColon).trim();
    expect(key).toBe("GitWand-Review");
  });
});

describe("resolveCommitReviewGate", () => {
  it("proceeds straight to commit when the feature is disabled", () => {
    expect(mod.resolveCommitReviewGate({ enabled: false, staged: 3, decision: null, iterations: 0 })).toBe("proceed");
  });

  it("proceeds when nothing is staged", () => {
    expect(mod.resolveCommitReviewGate({ enabled: true, staged: 0, decision: null, iterations: 0 })).toBe("proceed");
  });

  it("prompts when enabled, staged, no decision yet, and no review has run", () => {
    expect(mod.resolveCommitReviewGate({ enabled: true, staged: 3, decision: null, iterations: 0 })).toBe("prompt");
  });

  it("proceeds without re-prompting once a decision is already recorded", () => {
    expect(mod.resolveCommitReviewGate({ enabled: true, staged: 3, decision: "vouched", iterations: 0 })).toBe("proceed");
  });

  it("proceeds without prompting when a review already ran this cycle, even with no explicit decision", () => {
    // "Review staged changes" was clicked before ever hitting commit — don't
    // re-ask, the review already happened.
    expect(mod.resolveCommitReviewGate({ enabled: true, staged: 3, decision: null, iterations: 1 })).toBe("proceed");
  });
});

describe("appendReviewTrailer", () => {
  it("appends the GitWand-Review line AFTER the existing trailer block (Signed-off-by, Reviewed-by, ...)", () => {
    const existing = "Signed-off-by: A <a@x.com>\nReviewed-by: B <b@x.com>";
    const review = "GitWand-Review: ran (iter:1, coverage:100%)";
    const result = mod.appendReviewTrailer(existing, review);
    const lines = result.split("\n");
    expect(lines).toEqual([
      "Signed-off-by: A <a@x.com>",
      "Reviewed-by: B <b@x.com>",
      "GitWand-Review: ran (iter:1, coverage:100%)",
    ]);
  });

  it("returns just the review trailer when there are no other trailers", () => {
    expect(mod.appendReviewTrailer("", "GitWand-Review: skipped")).toBe("GitWand-Review: skipped");
  });

  it("returns the existing trailers unchanged when there's no review trailer to append", () => {
    expect(mod.appendReviewTrailer("Signed-off-by: A <a@x.com>", "")).toBe("Signed-off-by: A <a@x.com>");
  });

  it("returns an empty string when both sides are empty", () => {
    expect(mod.appendReviewTrailer("", "")).toBe("");
  });
});

describe("effectiveReviewDecision", () => {
  it("returns the explicit decision when one is set", () => {
    expect(mod.effectiveReviewDecision("skipped", 0)).toBe("skipped");
    expect(mod.effectiveReviewDecision("vouched", 2)).toBe("vouched");
  });

  it("defaults to 'ran' when no explicit decision but a review already happened", () => {
    expect(mod.effectiveReviewDecision(null, 1)).toBe("ran");
  });

  it("stays null when no decision and no review happened (the gate should have prompted)", () => {
    expect(mod.effectiveReviewDecision(null, 0)).toBeNull();
  });
});
