// @vitest-environment jsdom
/**
 * The CI tab follows a running CI: while it is shown and a check is still
 * running, the checks are re-fetched every 15 s; polling stops once every
 * check has finished, and the PR detail is then revalidated once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope } from "vue";

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

const scopes: ReturnType<typeof effectScope>[] = [];

async function openChecksTab() {
  const scope = effectScope();
  scopes.push(scope);
  const p = scope.run(() => usePrPanel(ref("/repo")))!;
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
    // Each panel registers a visibilitychange listener: dispose them all.
    scopes.splice(0).forEach((s) => s.stop());
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

  it("keeps the running list when a refresh comes back empty (a failed fetch)", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValueOnce([]).mockResolvedValue(running);
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    expect(p.prChecks.value).toEqual(running);
    expect(ghPrDetail).toHaveBeenCalledTimes(1); // not taken for a finished CI
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(3); // still following
  });

  it("gives up after three failed refreshes in a row", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockRejectedValue(new Error("offline"));
    await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 10);
    expect(ghPrChecks).toHaveBeenCalledTimes(4); // first load + 3 failures
  });

  it("re-opening the CI tab after giving up retries and resumes polling", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue(running);
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 5);
    expect(ghPrChecks).toHaveBeenCalledTimes(4);
    p.detailTab.value = "info";
    await flush();
    p.detailTab.value = "checks";
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(6);
  });

  it("does not re-arm the timer when disposed during an in-flight refresh", async () => {
    let release!: (v: unknown) => void;
    ghPrChecks.mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue(running);
    const scope = effectScope();
    const p = scope.run(() => usePrPanel(ref("/repo")))!;
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks";
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    scope.stop();
    release(running);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
  });

  it("returning to the window soon after a fetch does not fetch again at once", async () => {
    ghPrChecks.mockResolvedValue(running);
    await openChecksTab();
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
  });

  it("revalidates the detail when CI finished while the PR sat in the cache", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    expect(ghPrDetail).toHaveBeenCalledTimes(1);
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any); // restored from cache, running list
    p.detailTab.value = "checks";
    await flush();
    expect(p.prChecks.value).toEqual(done);
    // detail fetched for PR 1, PR 2, PR 1 (revalidation of the cached bundle)
    // plus once more because CI finished.
    const forPr1 = ghPrDetail.mock.calls.filter((c) => c[1] === 1).length;
    expect(forPr1).toBeGreaterThanOrEqual(3);
  });
});
