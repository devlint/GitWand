/**
 * v3.11.0 — apply from preview.
 *
 * The Conflict Predictor simulates: `git show` three blobs into scratch files
 * and `git merge-file` them. Nothing touches the index or the worktree. So
 * "apply" cannot mean writing the simulation out. It has to run the *real*
 * operation and re-run the engine against what git actually produced, which is
 * why this is orchestration over existing primitives rather than a new backend
 * capability.
 *
 * The behaviours pinned here are mostly about what the orchestrator must NOT
 * do. It must never auto-abort: an abort discards conflict resolution the user
 * may already have done by hand, and the snapshot only covers the worktree,
 * not their memory of which hunks they had reviewed. It must never auto-
 * continue past a residual: stopping with the operation in progress is what
 * hands control back. And it must not trust `stageFiles`, which swallows its
 * errors into a ref and never throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useApplyFromPreview, assertOperationSucceeded, type ApplyDeps } from "../useApplyFromPreview";

/** A conflict file as the orchestrator sees it. */
const file = (path: string, remaining: number, autoResolved = 0) => ({
  path,
  content: "irrelevant",
  result: {
    resolutions: Array.from({ length: autoResolved + remaining }, (_, i) => ({
      autoResolved: i < autoResolved,
      resolvedLines: i < autoResolved ? ["x"] : null,
      hunk: { confidence: { score: 100 } },
    })),
    stats: { totalConflicts: remaining, autoResolved, remaining },
  },
});

function makeDeps(over: Partial<ApplyDeps> = {}): ApplyDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps = {
    calls,
    cwd: () => "/repo",
    repoState: vi.fn(async () => ({ state: "clean" })),
    snapshot: vi.fn(async () => ({ id: "snap-1" })),
    runMerge: vi.fn(async () => { calls.push("merge"); }),
    runCherryPick: vi.fn(async () => { calls.push("cherry"); }),
    runRebaseOnto: vi.fn(async () => { calls.push("rebase"); return { conflict: false }; }),
    refresh: vi.fn(async () => { calls.push("refresh"); }),
    conflictedPaths: vi.fn(() => [] as string[]),
    openConflicts: vi.fn(async () => { calls.push("open"); }),
    resolveAll: vi.fn(async () => { calls.push("resolveAll"); }),
    saveAll: vi.fn(async () => { calls.push("saveAll"); }),
    stage: vi.fn(async () => { calls.push("stage"); }),
    files: vi.fn(() => [] as ReturnType<typeof file>[]),
    finalize: vi.fn(async () => { calls.push("finalize"); }),
    applyPredicateFor: () => undefined,
    ...over,
  } as unknown as ApplyDeps & { calls: string[] };
  return deps;
}

beforeEach(() => vi.clearAllMocks());

describe("useApplyFromPreview — the clean path", () => {
  it("merges, finds nothing conflicted, finalizes, and never runs the resolver", async () => {
    const deps = makeDeps();
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 3);

    expect(out.stoppedReason).toBe("clean");
    expect(out.finalized).toBe(true);
    expect(out.operationError).toBeNull();
    expect(deps.calls).toContain("merge");
    expect(deps.resolveAll, "nothing to resolve").not.toHaveBeenCalled();
    expect(deps.saveAll).not.toHaveBeenCalled();
  });

  it("captures a snapshot BEFORE touching the repo", async () => {
    const deps = makeDeps();
    const { apply } = useApplyFromPreview(deps);
    await apply("merge", "topic", 0);

    expect(deps.snapshot).toHaveBeenCalledTimes(1);
    const order = (deps.snapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const mergeOrder = (deps.runMerge as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(order, "snapshot precedes the operation").toBeLessThan(mergeOrder);
    // The existing "resolution" kind, not a new one: SnapshotMeta["kind"] is a
    // serialized union mirrored in Rust and the dev-server.
    expect(deps.snapshot).toHaveBeenCalledWith("/repo", "resolution", expect.stringContaining("merge"));
  });
});

describe("useApplyFromPreview — pre-flight", () => {
  it("refuses when an operation is already in progress, before any mutation", async () => {
    const deps = makeDeps({ repoState: vi.fn(async () => ({ state: "merge" })) });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 3);

    expect(out.stoppedReason).toBe("op-failed");
    expect(out.operationError).toMatch(/in progress/i);
    expect(deps.snapshot, "no snapshot for a refusal").not.toHaveBeenCalled();
    expect(deps.runMerge).not.toHaveBeenCalled();
  });
});

describe("useApplyFromPreview — conflicts", () => {
  it("resolves, saves, stages and finalizes when the residual is zero", async () => {
    let conflicted = ["a.ts"];
    const deps = makeDeps({
      conflictedPaths: vi.fn(() => conflicted),
      files: vi.fn(() => [file("a.ts", 0, 2)]),
      resolveAll: vi.fn(async () => { conflicted = []; }),
    });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 2);

    expect(out.stoppedReason).toBe("clean");
    expect(out.finalized).toBe(true);
    expect(out.appliedHunks, "counted from the REAL run, not the estimate").toBe(2);
    expect(out.filesResolved).toEqual(["a.ts"]);
    expect(deps.stage).toHaveBeenCalledWith(["a.ts"]);
    expect(deps.finalize).toHaveBeenCalledTimes(1);
  });

  it("STOPS on a residual: no finalize, operation left in progress", async () => {
    const deps = makeDeps({
      conflictedPaths: vi.fn(() => ["a.ts", "b.ts"]),
      files: vi.fn(() => [file("a.ts", 0, 2), file("b.ts", 3, 0)]),
    });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 5);

    expect(out.stoppedReason).toBe("residual");
    expect(out.finalized, "the user finishes this themselves").toBe(false);
    expect(out.residualFiles).toEqual(["b.ts"]);
    expect(out.residualHunks).toBe(3);
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("reports drift when the estimate and the actual disagree", async () => {
    const deps = makeDeps({
      conflictedPaths: vi.fn(() => ["a.ts"]),
      files: vi.fn(() => [file("a.ts", 1, 1)]),
    });
    const { apply } = useApplyFromPreview(deps);

    // The preview guessed 7; the real merge produced 2 hunks.
    const out = await apply("merge", "topic", 7);

    expect(out.estimatedHunks).toBe(7);
    expect(out.appliedHunks + out.residualHunks).toBe(2);
    expect(out.estimateDrifted, "the UI must say so rather than quietly differ").toBe(true);
  });
});

describe("useApplyFromPreview — failures never destroy work", () => {
  it("an operation that fails outright leaves no abort behind", async () => {
    const deps = makeDeps({
      runMerge: vi.fn(async () => { throw new Error("refusing to merge unrelated histories"); }),
    });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 3);

    expect(out.stoppedReason).toBe("op-failed");
    expect(out.operationError).toContain("unrelated histories");
    expect(out.snapshotId, "the escape hatch is reported").toBe("snap-1");
    expect(deps.resolveAll, "nothing was resolved").not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("a resolver failure mid-way leaves the operation in progress and does NOT abort", async () => {
    const deps = makeDeps({
      conflictedPaths: vi.fn(() => ["a.ts"]),
      files: vi.fn(() => [file("a.ts", 0, 2)]),
      resolveAll: vi.fn(async () => { throw new Error("worker died"); }),
    });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 2);

    expect(out.stoppedReason).toBe("resolve-failed");
    expect(out.operationError).toContain("worker died");
    expect(out.finalized).toBe(false);
    // Aborting here would throw away whatever the user had already resolved.
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("detects a silently-swallowed staging failure", async () => {
    // useGitRepo.stageFiles catches into `error` and never throws, so absence
    // of an exception proves nothing. The check has to be the conflicted set.
    const deps = makeDeps({
      conflictedPaths: vi.fn(() => ["a.ts"]),
      files: vi.fn(() => [file("a.ts", 0, 2)]),
      resolveAll: vi.fn(async () => { /* resolved in memory */ }),
      stage: vi.fn(async () => { /* silently does nothing */ }),
    });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 2);

    expect(out.finalized, "still conflicted after staging: do not continue").toBe(false);
    expect(out.stoppedReason).toBe("residual");
  });
});

describe("assertOperationSucceeded — the wrappers that never throw", () => {
  /**
   * `useGitRepo.mergeBranch` and `cherryPick` catch everything into
   * `error.value`, and also swallow a `{ success: false }` result. Wiring the
   * orchestrator to them meant a merge git REFUSED came back looking like a
   * clean success: no conflicts, the loop breaks immediately, and the report
   * claimed `finalized: true` and "0 applied, 0 left" for an operation that
   * never ran. Exactly the hazard this file's header calls out for
   * `stageFiles`, caught there and missed here.
   */
  it("throws on an explicit failure, so op-failed is reachable at all", () => {
    expect(() =>
      assertOperationSucceeded({ success: false, message: "refusing to merge unrelated histories" }, "merge x"),
    ).toThrow(/unrelated histories/);
  });

  it("uses a sensible message when git gave none", () => {
    expect(() => assertOperationSucceeded({ success: false }, "merge topic")).toThrow(/merge topic/);
  });

  it("treats a CONFLICT as success: git did the work and stopped correctly", () => {
    expect(() => assertOperationSucceeded({ success: false, conflicts: true }, "merge x")).not.toThrow();
  });

  it("accepts a plain success", () => {
    expect(() => assertOperationSucceeded({ success: true }, "merge x")).not.toThrow();
  });

  it("throws rather than assuming success when there is no result at all", () => {
    expect(() => assertOperationSucceeded(undefined, "merge x")).toThrow();
  });
});

describe("useApplyFromPreview — rebase replays step by step", () => {
  /**
   * A rebase replays each commit separately, so it can halt more than once.
   * The real sequence per halt is: conflicts appear, we resolve and stage them
   * (git now reports nothing conflicted), we `rebase --continue`, and the NEXT
   * commit may halt in turn. A fake where the conflict survives its own
   * resolution models a step that could not be resolved, which is the residual
   * case, not the looping one.
   */
  function rebaseDeps(steps: number) {
    let conflicted = true;
    let remaining = steps;
    const deps = makeDeps({
      runRebaseOnto: vi.fn(async () => ({ conflict: true })),
      conflictedPaths: vi.fn(() => (conflicted ? ["a.ts"] : [])),
      files: vi.fn(() => [file("a.ts", 0, 1)]),
      resolveAll: vi.fn(async () => { conflicted = false; }),
      finalize: vi.fn(async () => {
        remaining--;
        // The next replayed commit conflicts too, until the stack runs out.
        conflicted = remaining > 0;
      }),
    });
    return deps;
  }

  it("loops through every halted step until the rebase is done", async () => {
    const deps = rebaseDeps(3);
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("rebase", "main", 3);

    expect(out.stoppedReason).toBe("clean");
    expect(deps.resolveAll).toHaveBeenCalledTimes(3);
    expect(out.appliedHunks, "each replayed step counts").toBe(3);
  });

  it("is bounded, and says so rather than spinning forever", async () => {
    // A rebase that keeps halting past the bound: every step resolves, but
    // there is always another one.
    const deps = rebaseDeps(Number.POSITIVE_INFINITY);
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("rebase", "main", 1);

    expect(out.stoppedReason).toBe("loop-bound");
    expect((deps.resolveAll as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(100);
  }, 20_000);

  it("stops with a residual when a step cannot be fully resolved", async () => {
    // The conflict survives its own resolution: this step needs a human.
    const deps = makeDeps({
      runRebaseOnto: vi.fn(async () => ({ conflict: true })),
      conflictedPaths: vi.fn(() => ["a.ts"]),
      files: vi.fn(() => [file("a.ts", 2, 0)]),
    });
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("rebase", "main", 2);

    expect(out.stoppedReason).toBe("residual");
    expect(out.residualFiles).toEqual(["a.ts"]);
    expect(deps.finalize, "never advance past a conflict we did not solve").not.toHaveBeenCalled();
  });
});
