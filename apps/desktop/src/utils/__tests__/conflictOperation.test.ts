/**
 * resolveConflictOperation — which operation the conflict banner and the
 * post-resolution "continue" chain are actually looking at.
 *
 * Why this exists: `isCherryPicking` is a frontend ref set when *this app*
 * starts a cherry-pick. It does not survive opening a repository that is
 * already mid-cherry-pick, so the banner offered "Abort merge" and the
 * continue chain ran `git merge --continue` on a repo with no MERGE_HEAD.
 * The repository on disk knows better, and `gitRepoState` already reports it.
 *
 * The rule: when the disk says which operation is in progress, the disk wins.
 * Only when it cannot say do we fall back to the frontend flag.
 */
import { describe, it, expect } from "vitest";

import { resolveConflictOperation } from "../conflictOperation";

describe("resolveConflictOperation", () => {
  it("reports a cherry-pick the app never started", () => {
    // The regression that motivated this: repo opened mid-cherry-pick, so the
    // flag is false, and the banner used to offer "Abort merge".
    expect(resolveConflictOperation("cherry_pick", false)).toBe("cherry_pick");
  });

  it("reports a merge", () => {
    expect(resolveConflictOperation("merge", false)).toBe("merge");
  });

  it("lets the disk override a stale frontend flag", () => {
    // Flag says cherry-pick, disk says merge: the disk is the repository.
    expect(resolveConflictOperation("merge", true)).toBe("merge");
  });

  it("treats a revert as a merge, which is what the app can actually abort", () => {
    // There is no `git revert --abort` wrapper in the app; falling back to the
    // merge action keeps today's behaviour rather than offering a dead button.
    expect(resolveConflictOperation("revert", false)).toBe("merge");
  });

  it("falls back to the flag when the disk state could not be read", () => {
    // gitRepoState threw — the flag is the only signal left, and it is right
    // when this app just started the cherry-pick itself.
    expect(resolveConflictOperation(null, true)).toBe("cherry_pick");
  });

  it("falls back to the flag when the disk reports no operation", () => {
    // "clean" with conflicts on screen means the read raced the operation;
    // trust the flag rather than contradict what the user just did.
    expect(resolveConflictOperation("clean", true)).toBe("cherry_pick");
  });

  it("defaults to merge when neither source knows", () => {
    expect(resolveConflictOperation(null, false)).toBe("merge");
    expect(resolveConflictOperation("clean", false)).toBe("merge");
  });

  it("leaves a rebase to the rebase banner by reporting merge", () => {
    // The conflict banner is suppressed during a rebase (showRebaseBanner), so
    // this value is never used there; it must still be a safe default.
    expect(resolveConflictOperation("rebase", false)).toBe("merge");
    expect(resolveConflictOperation("rebase_interactive", false)).toBe("merge");
  });
});
