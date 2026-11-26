import { describe, it, expect } from "vitest";
import { isBisect, pollsRepoState, showsOperationBanner } from "../operationKinds";
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

  it("sets a bisect apart: no 3 s poll, no Continue/Abort banner", () => {
    expect(isBisect(op("bisect"))).toBe(true);
    expect(pollsRepoState(op("bisect"))).toBe(false);
    expect(showsOperationBanner(op("bisect"))).toBe(false);
  });

  it.each(["rebase", "rebase_interactive", "merge", "cherry_pick", "revert"] as const)(
    "keeps %s as before",
    (state) => {
      expect(isBisect(op(state))).toBe(false);
      expect(pollsRepoState(op(state))).toBe(true);
      expect(showsOperationBanner(op(state))).toBe(true);
    },
  );
});
