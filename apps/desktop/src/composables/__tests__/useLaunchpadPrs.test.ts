import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetPinsForTesting, useLaunchpadPins } from "../useLaunchpadPins";

const listPRs = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeForRepo: vi.fn(async (cwd: string) => ({
    name: cwd.includes("gl") ? "gitlab" : cwd.includes("bb") ? "bitbucket" : "github",
    listPRs,
  })),
  isForgeConnected: vi.fn((forge: string) => forge !== "bitbucket"), // bb NOT connected
}));

import { useLaunchpadPrs } from "../useLaunchpadPrs";

describe("useLaunchpadPrs multi-forge", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
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

describe("useLaunchpadPrs — pin/snooze integration", () => {
  const PR1_URL = "https://github.com/org/alpha/pull/10";
  const PR2_URL = "https://github.com/org/alpha/pull/20";

  // PR1 is older (createdAt earlier) — without pinning it would sort behind PR2
  const makePr = (n: number, url: string, createdAt: string) => ({
    number: n, title: `PR ${n}`, state: "open", author: "me", branch: "f",
    base: "main", draft: false, createdAt, updatedAt: createdAt,
    url, additions: 0, deletions: 0, labels: [], assignees: [],
    reviewRequested: [], reviewDecision: "", mergeStateStatus: "",
    checksRollup: "", commentCount: 0,
  });

  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
    listPRs.mockReset();
    // Default: return both PRs for any repo
    listPRs.mockResolvedValue([
      makePr(10, PR1_URL, "2026-04-01T10:00:00Z"), // older → normally sorts second
      makePr(20, PR2_URL, "2026-05-01T10:00:00Z"), // newer → normally sorts first
    ]);
  });

  it("pinned PR appears before non-pinned PR in allPrs", async () => {
    const pins = useLaunchpadPins();
    // Pin PR1 (the older one) — it should jump to the front
    pins.pin(PR1_URL, "pr");

    const lp = useLaunchpadPrs();
    await lp.refresh([{ path: "/repo-gh", name: "gh" }] as any);

    expect(lp.allPrs.value[0].url).toBe(PR1_URL);
    expect(lp.allPrs.value[1].url).toBe(PR2_URL);
  });

  it("snoozed PR is absent from allPrs and present in snoozedPrs", async () => {
    const pins = useLaunchpadPins();
    pins.snooze(PR1_URL, "pr", 1);

    const lp = useLaunchpadPrs();
    await lp.refresh([{ path: "/repo-gh", name: "gh" }] as any);

    expect(lp.allPrs.value.find((p) => p.url === PR1_URL)).toBeUndefined();
    expect(lp.allPrs.value.find((p) => p.url === PR2_URL)).toBeDefined();
    expect(lp.snoozedPrs.value.find((p) => p.url === PR1_URL)).toBeDefined();
  });

  it("pinned+snoozed PR is absent from allPrs (snooze takes priority)", async () => {
    const pins = useLaunchpadPins();
    pins.pin(PR1_URL, "pr");
    pins.snooze(PR1_URL, "pr", 1);

    const lp = useLaunchpadPrs();
    await lp.refresh([{ path: "/repo-gh", name: "gh" }] as any);

    expect(lp.allPrs.value.find((p) => p.url === PR1_URL)).toBeUndefined();
  });
});
