/**
 * The CI tab follows a running CI: while it is shown and a check is still
 * running, the checks are re-fetched every 15 s; polling stops once every
 * check has finished, and the PR detail is then revalidated once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrChecks = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrChecks: (...a: unknown[]) => ghPrChecks(...a),
    ghPrComments: vi.fn(async () => []),
    ghPrIssueComments: vi.fn(async () => []),
    ghPrListReviews: vi.fn(async () => []),
    ghPrAnnotations: vi.fn(async () => []),
    gitFileCount: vi.fn(async () => 0),
    ghPrDiff: vi.fn(async () => ""),
  };
});

import { usePrPanel, CHECKS_LIVE_INTERVAL_MS } from "../usePrPanel";

const running = [{ name: "build", state: "IN_PROGRESS", conclusion: "", detailsUrl: "" }];
const done = [{ name: "build", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "" }];

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "pending", canMerge: true, headSha: "abc",
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function openChecksTab() {
  const p = usePrPanel(ref("/repo"));
  await p.selectPr({ number: 1 } as any);
  p.detailTab.value = "checks";
  await flush();
  return p;
}

describe("usePrPanel — live CI checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-fetches the checks while one is running, then stops once all have finished", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    expect(ghPrChecks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(3);
    expect(p.prChecks.value).toEqual(done);

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(3);
  });

  it("revalidates the PR detail once when the last check finishes", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    await openChecksTab();
    expect(ghPrDetail).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 3);
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
  });

  it("does not poll when every check has already finished", async () => {
    ghPrChecks.mockResolvedValue(done);
    await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(1);
  });

  it("stops polling when another tab is shown", async () => {
    ghPrChecks.mockResolvedValue(running);
    const p = await openChecksTab();
    p.detailTab.value = "info";
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(1);
  });

  it("re-opening the CI tab refreshes checks that were still running", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    p.detailTab.value = "info";
    await flush();
    p.detailTab.value = "checks";
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    expect(p.prChecks.value).toEqual(done);
  });
});
