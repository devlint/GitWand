import { describe, it, expect } from "vitest";
import { isBisect, movesBisect, pollsRepoState, showsOperationBanner } from "../operationKinds";
import type { RepoOperationState } from "../backend";

const op = (state: RepoOperationState["state"]): RepoOperationState => ({
  state,
  hasConflict: false,
  operationHead: null,
  targetBranch: null,
  step: 0,
  total: 0,
});

describe("operationKinds", () => {
  it("knows nothing is in progress", () => {
    expect(isBisect(null)).toBe(false);
    expect(pollsRepoState(null)).toBe(false);
    expect(showsOperationBanner(null)).toBe(false);
  });

  it("sets a bisect apart: polled only without the watcher, no Continue/Abort banner", () => {
    expect(isBisect(op("bisect"))).toBe(true);
    expect(pollsRepoState(op("bisect"), true)).toBe(false);
    expect(pollsRepoState(op("bisect"), false)).toBe(true);
    expect(showsOperationBanner(op("bisect"))).toBe(false);
  });

  it.each(["rebase", "rebase_interactive", "merge", "cherry_pick", "revert"] as const)(
    "keeps %s as before",
    (state) => {
      expect(isBisect(op(state))).toBe(false);
      expect(pollsRepoState(op(state))).toBe(true);
      expect(pollsRepoState(op(state), true)).toBe(true);
      expect(showsOperationBanner(op(state))).toBe(true);
    },
  );

  it("tells the watcher events that can move a bisect", () => {
    const ev = (kinds: string[], paths: string[], truncated = false) => ({ kinds, paths, truncated });
    expect(movesBisect(ev(["refs"], [".git/refs/bisect/good-abc"]))).toBe(true);
    expect(movesBisect(ev(["head"], [".git/HEAD"]))).toBe(true);
    expect(movesBisect(ev(["mergeState"], [".git/BISECT_LOG"]))).toBe(true);
    expect(movesBisect(ev(["refs"], [".git/packed-refs"]))).toBe(true);
    expect(movesBisect(ev(["refs"], [".git/refs/remotes/origin/main"], true))).toBe(true);
    expect(movesBisect(ev(["refs"], [".git/refs/remotes/origin/main", ".git/refs/tags/v1"]))).toBe(false);
  });
});
