import { describe, it, expect, vi, beforeEach } from "vitest";

const listPRs = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeForRepo: vi.fn(async (cwd: string) => ({
    name: cwd.includes("gl") ? "gitlab" : cwd.includes("bb") ? "bitbucket" : "github",
    listPRs,
  })),
  isForgeConnected: vi.fn((forge: string) => forge !== "bitbucket"), // bb NOT connected
}));
vi.mock("../useLaunchpadPins", () => ({
  useLaunchpadPins: () => ({ isPinned: () => false, isSnoozed: () => false }),
}));

import { useLaunchpadPrs } from "../useLaunchpadPrs";

describe("useLaunchpadPrs multi-forge", () => {
  beforeEach(() => {
    listPRs.mockReset();
    listPRs.mockImplementation(async (cwd: string) => [
      { number: 1, title: `PR for ${cwd}`, state: "open", author: "me", branch: "f",
        base: "main", draft: false, createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${cwd}/1`, additions: 0,
        deletions: 0, labels: [], assignees: [], reviewRequested: [], reviewDecision: "",
        mergeStateStatus: "", checksRollup: "", commentCount: 0 },
    ]);
  });

  it("aggregates PRs from connected forges and skips not-connected ones", async () => {
    const lp = useLaunchpadPrs();
    await lp.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-gl", name: "gl" },
      { path: "/repo-bb", name: "bb" }, // bitbucket → not connected → skipped
    ] as any);
    // github + gitlab fetched; bitbucket skipped
    expect(listPRs).toHaveBeenCalledTimes(2);
    expect(lp.allPrs.value).toHaveLength(2);
    expect(lp.needsConnection.value).toContain("bitbucket");
  });

  it("captures a per-repo error without failing the whole refresh", async () => {
    listPRs.mockImplementationOnce(async () => { throw new Error("boom"); });
    const lp = useLaunchpadPrs();
    await lp.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-gl", name: "gl" },
    ] as any);
    const errored = lp.repos.value.find((r) => r.error);
    expect(errored).toBeTruthy();
    expect(lp.error.value).toBeNull(); // top-level error stays null
  });
});
