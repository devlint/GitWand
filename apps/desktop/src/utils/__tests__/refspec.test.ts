import { describe, it, expect } from "vitest";
import { remoteBranchOf, trackingRefOf } from "../refspec";

// Same cases as `remote_branch_of_reads_refspecs_back` in ops.rs.
describe("remoteBranchOf", () => {
  it("reads the default, custom and single-branch refspecs back", () => {
    const glob = "+refs/heads/*:refs/remotes/origin/*";
    expect(remoteBranchOf(glob, "refs/remotes/origin/feat/x")).toBe("feat/x");
    expect(remoteBranchOf(glob, "refs/remotes/fork/feat")).toBeNull();
    expect(remoteBranchOf("+refs/heads/*:refs/remotes/origin/heads/*", "refs/remotes/origin/heads/main")).toBe("main");
    const single = "+refs/heads/main:refs/remotes/origin/main\n+refs/heads/dev:refs/remotes/origin/dev";
    expect(remoteBranchOf(single, "refs/remotes/origin/dev")).toBe("dev");
    expect(remoteBranchOf(single, "refs/remotes/origin/other")).toBeNull();
  });

  it("maps nothing that is not a branch", () => {
    expect(remoteBranchOf("+refs/tags/*:refs/remotes/origin/*", "refs/remotes/origin/v1")).toBeNull();
    expect(remoteBranchOf("^refs/heads/x", "refs/remotes/origin/x")).toBeNull();
    expect(remoteBranchOf("", "refs/remotes/origin/main")).toBeNull();
  });
});

describe("trackingRefOf", () => {
  it("maps a branch forward through default, custom and single-branch refspecs", () => {
    expect(trackingRefOf("+refs/heads/*:refs/remotes/origin/*", "feat/x")).toBe("refs/remotes/origin/feat/x");
    expect(trackingRefOf("+refs/heads/*:refs/remotes/origin/heads/*", "main")).toBe("refs/remotes/origin/heads/main");
    expect(trackingRefOf("+refs/heads/main:refs/remotes/origin/main", "main")).toBe("refs/remotes/origin/main");
    expect(trackingRefOf("+refs/heads/main:refs/remotes/origin/main", "dev")).toBeNull();
    expect(trackingRefOf("", "main")).toBeNull();
  });
});
