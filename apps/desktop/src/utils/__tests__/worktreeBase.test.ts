import { describe, it, expect } from "vitest";
import { describeBase, slugifyWorktreeName } from "../worktreeBase";

const b = (over: object) => ({
  base_ref: "origin/main",
  commit: "c",
  fetched_at: null,
  fallback_reason: null,
  fallback_detail: null,
  ...over,
});

describe("describeBase", () => {
  it("says how long ago a fresh base was fetched", () => {
    expect(describeBase(b({ fetched_at: 100 }), 102_000)).toEqual({ key: "worktree.baseFetched", args: ["origin/main", 2] });
  });
  it("names each fallback", () => {
    expect(describeBase(b({ fallback_reason: "fetch-failed" }), 0).key).toBe("worktree.baseOffline");
    expect(describeBase(b({ base_ref: "main", fallback_reason: "no-remote" }), 0)).toEqual({ key: "worktree.baseNoRemote", args: ["main"] });
    expect(describeBase(b({ fallback_reason: "no-default-branch" }), 0).key).toBe("worktree.baseNoDefault");
  });
  it("an explicit base is just named", () => {
    expect(describeBase(b({ base_ref: "feature" }), 0)).toEqual({ key: "worktree.baseExplicit", args: ["feature"] });
  });
});

describe("slugifyWorktreeName", () => {
  it("matches the backend slug", () => {
    expect(slugifyWorktreeName("Fix/Login Bug!")).toBe("fix-login-bug");
    expect(slugifyWorktreeName("!!!")).toBeNull();
    expect(slugifyWorktreeName("a".repeat(80))).toHaveLength(63);
  });
});
