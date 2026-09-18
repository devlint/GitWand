/**
 * resolveConflictOperation — which operation the repository is in.
 *
 * The repository is the only source. `isCherryPicking` was a frontend ref set
 * when *this app* started a cherry-pick; it did not survive opening a repo
 * already mid-cherry-pick, so the banner offered "Abort merge" and the
 * continue chain ran `git merge --continue` where no MERGE_HEAD existed.
 * #201 made this read authoritative; the unified operation model removed the
 * flag, so there is no fallback left to disagree with it.
 */
import { describe, it, expect } from "vitest";

import { resolveConflictOperation } from "../conflictOperation";

describe("resolveConflictOperation", () => {
  it("names a cherry-pick the app never started", () => {
    // The regression that motivated the read in the first place.
    expect(resolveConflictOperation("cherry_pick")).toBe("cherry_pick");
  });

  it("names a merge", () => {
    expect(resolveConflictOperation("merge")).toBe("merge");
  });

  it("names a revert, which now has actions of its own", () => {
    expect(resolveConflictOperation("revert")).toBe("revert");
  });

  it("collapses an interactive rebase to a rebase", () => {
    // continue/abort/skip are the same git subcommand either way.
    expect(resolveConflictOperation("rebase")).toBe("rebase");
    expect(resolveConflictOperation("rebase_interactive")).toBe("rebase");
  });

  it("returns null when no operation is in progress", () => {
    expect(resolveConflictOperation("clean")).toBeNull();
  });

  it("returns null when the state could not be read", () => {
    // A failed read knows nothing, and there is no flag to fall back on: the
    // caller must do nothing rather than guess at an operation.
    expect(resolveConflictOperation(null)).toBeNull();
  });
});
