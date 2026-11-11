// @vitest-environment jsdom
/**
 * The CI tab follows a running CI: while it is shown and a check is still
 * running, the checks are re-fetched every 15 s; polling stops once every
 * check has finished, and the PR detail is then revalidated once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope } from "vue";
import { usePrCache, listKey, _resetPrCacheForTesting } from "../usePrCache";
import { ForgeNotImplementedError } from "../forge/types";

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

import {
  usePrPanel, CHECKS_LIVE_INTERVAL_MS, CHECKS_LIVE_SLOW_AFTER_MS, CHECKS_LIVE_SLOW_INTERVAL_MS,
  OTHER_COMMIT_FOLLOW_MS, _resetOtherCommitForTesting, computeAutoMergeOffer,
} from "../usePrPanel";

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
  p.setDetailVisible(true);
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
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS); // time spent on Info
    p.detailTab.value = "checks";
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    expect(p.prChecks.value).toEqual(done);
  });

  it("keeps the running list when a refresh fails", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(running);
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
    p.setDetailVisible(true);
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

  it("reopening a cached PR whose CI finished meanwhile does not fetch the detail twice", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    const reopen = p.selectPr({ number: 1 } as any); // fetches the detail itself
    p.detailTab.value = "checks";
    await reopen;
    await flush();
    expect(p.prChecks.value).toEqual(done);
    expect(ghPrDetail.mock.calls.filter((c) => c[1] === 1).length).toBe(2); // open + reopen
  });

  it("revalidates the detail when CI finishes long after the last detail fetch", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    expect(ghPrDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
  });

  it("toggling back to the CI tab right after a fetch does not fetch again at once", async () => {
    ghPrChecks.mockResolvedValue(running);
    const p = await openChecksTab();
    p.detailTab.value = "info";
    await flush();
    p.detailTab.value = "checks";
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(1);
  });

  it("applies an empty list at once: the backends report failures as errors", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue([]);
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(p.prChecks.value).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
  });

  it("slows down to one fetch a minute when a check stays pending for long", async () => {
    ghPrChecks.mockResolvedValue(running);
    await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_AFTER_MS);
    const before = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_INTERVAL_MS * 2);
    expect(ghPrChecks.mock.calls.length - before).toBeLessThanOrEqual(2);
  });

  it("drops a refresh that started before the PR was re-selected", async () => {
    let release!: (v: unknown) => void;
    const older = [{ name: "old", state: "IN_PROGRESS", conclusion: "", detailsUrl: "" }];
    ghPrChecks.mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue(done);
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS); // refresh in flight
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks";
    await flush();
    expect(p.prChecks.value).toEqual(done);
    release(older);
    await flush();
    expect(p.prChecks.value).toEqual(done);
  });

});

describe("usePrPanel — live CI, third review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });

  it("loadChecks keeps cached running checks when the fetch fails", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockRejectedValueOnce(new Error("x")).mockResolvedValue(running);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    await p.selectPr({ number: 1 } as any); // cached running list
    p.detailTab.value = "checks";
    await flush();
    expect(p.prChecks.value).toEqual(running);
    expect(p.prs.value[0].checksRollup).toBe("PENDING");
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks.mock.calls.filter((c) => c[1] === 1).length).toBeGreaterThanOrEqual(3);
  });

  it("a new CI run on the same PR is polled at the fast rate again", async () => {
    ghPrChecks.mockResolvedValue(running);
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_AFTER_MS + CHECKS_LIVE_SLOW_INTERVAL_MS);
    ghPrChecks.mockResolvedValue(done);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_INTERVAL_MS);
    expect(p.prChecks.value).toEqual(done);
    // A push: the detail now reports a new head commit, and CI runs again.
    ghPrChecks.mockResolvedValue(running);
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(p.prChecks.value).toEqual(running);
    const before = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    // Fast rate: a fetch within 15 s (the slow rate would make none).
    expect(ghPrChecks.mock.calls.length).toBeGreaterThanOrEqual(before + 1);
    expect(ghPrChecks.mock.calls.length).toBeLessThanOrEqual(before + 2);
  });

  it("a push seen on another tab re-fetches the checks once, for the merge banner", async () => {
    ghPrChecks.mockResolvedValueOnce(done).mockResolvedValue(running);
    const p = await openChecksTab();
    p.detailTab.value = "info";
    await flush();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    expect(p.prChecks.value).toEqual(running);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 3);
    expect(ghPrChecks).toHaveBeenCalledTimes(2); // no polling off the CI tab
  });

  it("a push during an in-flight refresh drops the old answer and fetches the new head's", async () => {
    let release!: (v: unknown) => void;
    ghPrChecks.mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue(done);
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS); // refresh in flight
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(3);
    expect(p.prChecks.value).toEqual(done);
    release(running);
    await flush();
    expect(p.prChecks.value).toEqual(done);
  });

  it("drops a refresh whose answer arrives after the repository changed", async () => {
    let release!: (v: unknown) => void;
    const cwdRef = ref("/repo");
    ghPrChecks.mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue(running);
    const scope = effectScope();
    scopes.push(scope);
    const p = scope.run(() => usePrPanel(cwdRef))!;
    p.setDetailVisible(true);
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks";
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS); // refresh in flight
    cwdRef.value = "/other";
    await flush();
    await p.selectPr({ number: 1 } as any); // PR #1 of the other repo
    await flush();
    const before = p.prChecks.value;
    release(done);
    await flush();
    expect(p.prChecks.value).toBe(before);
  });
});

describe("usePrPanel — live CI, fifth review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });

  it("stops polling when the PR detail view is not shown, and resumes when it is", async () => {
    ghPrChecks.mockResolvedValue(running);
    const p = await openChecksTab();
    p.setDetailVisible(false);
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(1);
    p.setDetailVisible(true);
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2); // last fetch is stale: catch up
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(3);
  });

  it("after a push, an empty list (checks not registered yet) is not 'CI finished'", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue([]);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    const detailCalls = ghPrDetail.mock.calls.length;
    expect(p.prChecks.value).toEqual([]);
    expect(p.prs.value[0].checksRollup).toBe("PENDING");
    await flush();
    expect(ghPrDetail.mock.calls.length).toBe(detailCalls);
  });

  it("a failed first load is shown as an error and retried when the CI tab is reopened", async () => {
    ghPrChecks.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(done);
    const p = await openChecksTab();
    expect(p.checksError.value).toBe(true);
    p.detailTab.value = "info";
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    p.detailTab.value = "checks";
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    expect(p.prChecks.value).toEqual(done);
    expect(p.checksError.value).toBe(false);
  });

  it("reopening a cached PR whose head moved meanwhile is not taken for a push", async () => {
    ghPrChecks.mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    const reopen = p.selectPr({ number: 1 } as any); // cache paints abc, fetch brings def
    p.detailTab.value = "checks";
    await reopen;
    await flush();
    const n = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks.mock.calls.length).toBe(n); // no 2-minute await polling
  });

  it("a real push after the reopen is still detected", async () => {
    ghPrChecks.mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any); // same head: no settling change
    p.detailTab.value = "checks";
    await flush();
    const n = ghPrChecks.mock.calls.length;
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks.mock.calls.length).toBe(n + 1);
  });

});

describe("usePrPanel — live CI, sixth review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });

  it("the list dot follows the backend's own rollup once the detail is reloaded", async () => {
    _resetPrCacheForTesting();
    const cache = usePrCache();
    cache.setList(listKey("/repo", "open"), [{ number: 1, checksRollup: "PENDING" } as any], false);
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any, { number: 9, checksRollup: "PENDING" } as any];
    // A failing legacy commit status the check-runs don't show: the backend says failure.
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), checksStatus: "failure" });
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(p.prs.value[0].checksRollup).toBe("FAILURE");
    expect(p.prs.value[1].checksRollup).toBe("PENDING");
    expect(cache.getList(listKey("/repo", "open"))?.prs[0].checksRollup).toBe("FAILURE");
  });

  it("a detail status it cannot read leaves the row alone", async () => {
    ghPrChecks.mockResolvedValue(done);
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), checksStatus: "warning" });
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    await p.revalidateOpenDetail();
    expect(p.prs.value[0].checksRollup).toBe("PENDING");
  });

  it("says so when live updates stop after repeated failures", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockRejectedValue(new Error("offline"));
    const p = await openChecksTab();
    expect(p.checksError.value).toBe(false);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 3);
    expect(p.checksError.value).toBe(true);
    expect(p.prChecks.value).toEqual(running); // still shown
  });

  it("a push is still detected when the first detail fetch failed", async () => {
    ghPrChecks.mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    ghPrDetail.mockRejectedValueOnce(new Error("offline"));
    await p.selectPr({ number: 1 } as any); // cached abc, fetch fails
    p.detailTab.value = "checks";
    await flush();
    const n = ghPrChecks.mock.calls.length;
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks.mock.calls.length).toBe(n + 1);
  });

  it("does not rewrite the cache when a poll brings the same checks", async () => {
    _resetPrCacheForTesting();
    const cache = usePrCache();
    ghPrChecks.mockResolvedValue(running);
    await openChecksTab();
    const spy = vi.spyOn(window.localStorage, "setItem");
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 3);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    void cache;
  });
});

describe("usePrPanel — live CI, seventh review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });
  const approve = (p: any) => {
    p.prReviews.value = [{ state: "APPROVED", user: { login: "x" }, submitted_at: "1" } as any];
  };

  it("a push on a PR whose checks were never loaded does not hold the banner", async () => {
    window.localStorage.clear(); // no cached bundle from an earlier test
    _resetPrCacheForTesting();
    const scope = effectScope();
    scopes.push(scope);
    const p = scope.run(() => usePrPanel(ref("/repo")))!;
    p.setDetailVisible(true);
    await p.selectPr({ number: 1 } as any); // Info tab, checks never loaded
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    approve(p);
    expect(p.mergeReadiness.value?.ready).toBe(true);
  });

  it("a push on a PR that had no checks (no CI) does not hold the banner", async () => {
    ghPrChecks.mockResolvedValue([]);
    const p = await openChecksTab();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    approve(p);
    expect(p.mergeReadiness.value?.ready).toBe(true);
  });

  it("a backend rollup of '' (no CI, or a failed rollup) never clears the dot", async () => {
    ghPrChecks.mockResolvedValue(done);
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), checksStatus: "" });
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "FAILURE" } as any];
    await p.revalidateOpenDetail();
    expect(p.prs.value[0].checksRollup).toBe("FAILURE");
  });

  it("reopening a cached PR whose head moved re-fetches its checks once if none were fetched since", async () => {
    ghPrChecks.mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    const n = ghPrChecks.mock.calls.length;
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.selectPr({ number: 1 } as any); // Info tab: cached old-head checks
    await flush();
    expect(ghPrChecks.mock.calls.length).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks.mock.calls.length).toBe(n + 1); // no await-window polling
  });

  it("one failed load over a cached list does not claim live updates stopped", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(running);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks";
    await flush();
    expect(p.prChecks.value).toEqual(running);
    expect(p.checksError.value).toBe(false);
  });
});

describe("usePrPanel — live CI, eighth review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });

  it("a load that started before a push does not apply the old head's list", async () => {
    window.localStorage.clear();
    _resetPrCacheForTesting();
    let release!: (v: unknown) => void;
    ghPrChecks.mockResolvedValueOnce(done)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue([]);
    const p = await openChecksTab(); // PR 1 loaded: done
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks"; // loadChecks in flight (cached done shown)
    await flush();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail(); // push
    await flush();
    release(done); // the old head's answer
    await flush();
    expect(p.prChecks.value).toEqual([]); // the refetch for the new head, not the old answer
  });

  it("a push seen before the CI tab ever loaded re-fetches the cached checks", async () => {
    ghPrChecks.mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any); // Info, cached done, checks not loaded
    await flush();
    const n = ghPrChecks.mock.calls.length;
    ghPrChecks.mockResolvedValue(running);
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks.mock.calls.length).toBe(n + 1);
    expect(p.prChecks.value).toEqual(running);
  });

  it("a detail answer from another repository is dropped", async () => {
    let release!: (v: unknown) => void;
    const cwdRef = ref("/repo");
    ghPrChecks.mockResolvedValue(done);
    const scope = effectScope();
    scopes.push(scope);
    const p = scope.run(() => usePrPanel(cwdRef))!;
    p.setDetailVisible(true);
    ghPrDetail.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = p.selectPr({ number: 12 } as any); // repo X, in flight
    cwdRef.value = "/other";
    await flush();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), number: 12, headSha: "yyy", checksStatus: "success" });
    await p.selectPr({ number: 12 } as any); // repo Y
    p.prs.value = [{ number: 12, checksRollup: "PENDING" } as any];
    release({ ...fakeDetail(), number: 12, headSha: "xxx", checksStatus: "failure" });
    await first;
    await flush();
    expect(p.prDetail.value?.headSha).toBe("yyy");
    expect(p.prs.value[0].checksRollup).toBe("PENDING");
  });

  it("patchListRow does not rewrite storage when the value is unchanged", () => {
    _resetPrCacheForTesting();
    const cache = usePrCache();
    cache.setList(listKey("/r", "open"), [{ number: 1, checksRollup: "SUCCESS" } as any], false);
    const spy = vi.spyOn(window.localStorage, "setItem");
    cache.patchListRow("/r", 1, { checksRollup: "SUCCESS" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("usePrPanel — live CI, ninth review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });
  const push = async (p: any) => {
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
  };

  it("a refresh in flight for the same PR number in another repo does not block this one", async () => {
    let release!: (v: unknown) => void;
    const cwdRef = ref("/repo");
    ghPrChecks.mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue(done);
    const scope = effectScope();
    scopes.push(scope);
    const p = scope.run(() => usePrPanel(cwdRef))!;
    p.setDetailVisible(true);
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks";
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS); // refresh for /repo in flight
    cwdRef.value = "/other";
    await flush();
    await p.selectPr({ number: 1 } as any); // PR #1 of the other repo
    await flush();
    const n = ghPrChecks.mock.calls.length;
    await p.refreshChecks();
    expect(ghPrChecks.mock.calls.length).toBe(n + 1);
    release(running);
  });

  it("a forge without CI checks support reads as 'no checks', not as a load failure", async () => {
    window.localStorage.clear();
    _resetPrCacheForTesting();
    ghPrChecks.mockImplementation(() => { throw new ForgeNotImplementedError("cursor", "getCIChecks"); });
    const p = await openChecksTab();
    expect(p.prChecks.value).toEqual([]);
    expect(p.checksError.value).toBe(false);
  });

  it("a push is detected after moving between PRs in the same tick", async () => {
    ghPrChecks.mockResolvedValue(done);
    const p = await openChecksTab();
    await p.selectPr({ number: 2 } as any);
    await flush();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "zzz" });
    const reopen = p.selectPr({ number: 1 } as any); // settling fetch will move the head
    await p.selectPr({ number: 3 } as any); // …but the user moves on in the same tick
    await reopen;
    await flush();
    p.detailTab.value = "checks";
    await flush();
    const n = ghPrChecks.mock.calls.length;
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "yyy" });
    await p.revalidateOpenDetail(); // a real push on PR 3
    await flush();
    expect(ghPrChecks.mock.calls.length).toBe(n + 1);
  });
});

describe("usePrPanel — one notion of a running check", () => {
  beforeEach(() => {
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset();
  });

  it("mergeReadiness blocks on a check whose conclusion says it is running (GitLab, Bitbucket)", () => {
    const p = usePrPanel(ref("/repo"));
    p.prChecks.value = [{ name: "Pipeline #1", state: "running", conclusion: "IN_PROGRESS", detailsUrl: "" }];
    expect(p.mergeReadiness.value?.ready).toBe(false);
    p.prChecks.value = [{ name: "b", state: "in_progress", conclusion: "pending", detailsUrl: "" }];
    expect(p.mergeReadiness.value?.ready).toBe(false);
  });

  it("checkIcon shows the hourglass for every running state", () => {
    const p = usePrPanel(ref("/repo"));
    for (const [state, conclusion] of [["created", ""], ["WAITING", ""], ["REQUESTED", ""], ["running", "RUNNING"]]) {
      expect(p.checkIcon({ name: "c", state, conclusion, detailsUrl: "" })).toBe("⏳");
    }
  });
});

describe("usePrPanel — checks of another commit than the head", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    _resetPrCacheForTesting();
    _resetOtherCommitForTesting();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail()); // head "abc"
    ghPrChecks.mockReset();
  });
  afterEach(() => {
    scopes.splice(0).forEach((s) => s.stop());
    vi.useRealTimers();
  });
  const check = (name: string, sha: string, conclusion = "SUCCESS", state = "COMPLETED") =>
    ({ name, state, conclusion, detailsUrl: "", commitSha: sha });
  const on = (sha: string, conclusion = "SUCCESS") => [check("build", sha, conclusion)];
  const runningOn = (sha: string) => [check("build", sha, "", "IN_PROGRESS")];
  const approve = (p: any) => {
    p.prReviews.value = [{ state: "APPROVED", user: { login: "x" }, submitted_at: "1" } as any];
  };

  it("keeps following finished checks of an older commit until the head's come", async () => {
    ghPrChecks.mockResolvedValueOnce(on("old")).mockResolvedValueOnce(on("old")).mockResolvedValue(on("abc"));
    const p = await openChecksTab();
    expect(p.checksOtherCommit.value).toBe("old");

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(3);
    expect(p.checksOtherCommit.value).toBeNull();

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(3);
  });

  it("stops following another commit's checks after a while: the head may get no CI", async () => {
    ghPrChecks.mockResolvedValue(on("old"));
    await openChecksTab();
    await vi.advanceTimersByTimeAsync(OTHER_COMMIT_FOLLOW_MS + CHECKS_LIVE_SLOW_INTERVAL_MS);
    const calls = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_INTERVAL_MS * 5);
    expect(ghPrChecks).toHaveBeenCalledTimes(calls);
  });

  it("leaves the merge banner as it is: green checks of another commit read green", async () => {
    // Which side lags is unknown, and the head may never get CI of its own
    // (GitLab `[skip ci]`): the banner reads every check, as it always did, and
    // never offers to arm auto-merge on a PR it calls ready.
    ghPrChecks.mockResolvedValue(on("old"));
    const p = await openChecksTab();
    approve(p);
    expect(p.checksOtherCommit.value).toBe("old");
    expect(p.mergeReadiness.value?.ready).toBe(true);
    expect(p.mergeBlocked.value).toBe(false);
    expect(computeAutoMergeOffer(
      { supported: true } as any, { armed: false, available: true } as any, p.mergeReadiness.value, true,
    ).kind).not.toBe("arm");
  });

  it("another commit's failed checks still block: which side lags is unknown", async () => {
    // A detail fetched before a push lags behind GitHub's checks: a red check
    // "of another commit" may be the head's real one.
    ghPrChecks.mockResolvedValue(on("new", "FAILURE"));
    ghPrDetail.mockResolvedValueOnce(fakeDetail()).mockRejectedValue(new Error("offline"));
    const p = await openChecksTab();
    approve(p);
    expect(p.checksOtherCommit.value).toBe("new");
    expect(p.mergeBlocked.value).toBe(true);
  });

  it("revalidates the detail even right after fetching it: that fetch may predate the push", async () => {
    ghPrChecks.mockResolvedValue(on("new"));
    ghPrDetail.mockResolvedValueOnce(fakeDetail()).mockResolvedValue({ ...fakeDetail(), headSha: "new" });
    const p = await openChecksTab();
    await vi.waitFor(() => expect(p.prDetail.value?.headSha).toBe("new"));
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
  });

  it("a push restarts the follow window", async () => {
    ghPrChecks.mockResolvedValue(on("old"));
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(OTHER_COMMIT_FOLLOW_MS + CHECKS_LIVE_SLOW_INTERVAL_MS);
    const before = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_INTERVAL_MS * 2);
    expect(ghPrChecks).toHaveBeenCalledTimes(before); // window over

    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "pushed" });
    await p.revalidateOpenDetail();
    await flush();
    const afterPush = ghPrChecks.mock.calls.length;
    expect(afterPush).toBe(before + 1); // the push's own refetch
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(ghPrChecks).toHaveBeenCalledTimes(afterPush + 1); // followed again
  });

  it("re-opening the CI tab after the follow window fetches once more", async () => {
    ghPrChecks.mockResolvedValue(on("old"));
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(OTHER_COMMIT_FOLLOW_MS + CHECKS_LIVE_SLOW_INTERVAL_MS * 2);
    const before = ghPrChecks.mock.calls.length;
    p.detailTab.value = "info";
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    p.detailTab.value = "checks";
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(before + 1);
  });

  it("checks that name no commit still block (an Azure reviewer policy)", async () => {
    ghPrChecks.mockResolvedValue([check("build", "old"), check("At least 1 reviewer must approve", "", "", "waiting")]);
    const p = await openChecksTab();
    approve(p);
    expect(p.mergeBlocked.value).toBe(true);
    expect(p.mergeReadiness.value?.reason).toContain("At least 1 reviewer must approve");
  });

  it("revalidates the detail once when the checks report a commit it has not seen", async () => {
    // The detail was fetched before a push the checks backend already reads.
    ghPrChecks.mockResolvedValueOnce(runningOn("abc")).mockResolvedValue(runningOn("new"));
    const p = await openChecksTab();
    expect(ghPrDetail).toHaveBeenCalledTimes(1);

    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "new" });
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
    expect(p.prDetail.value?.headSha).toBe("new");
    expect(p.checksOtherCommit.value).toBeNull();

    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 3);
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
  });

  it("checks that finish on another commit revalidate the detail once, not twice", async () => {
    // The last running check finishes on the same poll that first shows the
    // other commit: one revalidation serves both, and the follow window starts.
    ghPrChecks.mockResolvedValueOnce(runningOn("abc")).mockResolvedValue(on("old"));
    await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 3);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
  });

  it("does not revalidate the detail more than once for checks that lag behind it", async () => {
    ghPrChecks.mockResolvedValueOnce(runningOn("abc")).mockResolvedValue(runningOn("old"));
    await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2); // once, to settle which side lags
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
  });

  it("a slower, older detail answer does not move the head backwards", async () => {
    ghPrChecks.mockResolvedValueOnce(runningOn("abc")).mockResolvedValue(runningOn("new"));
    const p = await openChecksTab();
    let releaseSlow!: (v: unknown) => void;
    ghPrDetail
      .mockImplementationOnce(() => new Promise((r) => { releaseSlow = r; }))
      .mockResolvedValue({ ...fakeDetail(), headSha: "new" });
    const slow = p.revalidateOpenDetail(); // a periodic reload, slow
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS); // the checks see the push
    await flush();
    expect(p.prDetail.value?.headSha).toBe("new");
    releaseSlow(fakeDetail()); // head "abc", from before the push
    await slow;
    await flush();
    expect(p.prDetail.value?.headSha).toBe("new");
  });

  it("a push whose checks are already on screen does not refetch them", async () => {
    // GitHub: its backend reads the head, so the checks reveal the push first.
    ghPrChecks.mockResolvedValueOnce(runningOn("abc")).mockResolvedValue(runningOn("new"));
    ghPrDetail.mockResolvedValueOnce(fakeDetail()).mockResolvedValue({ ...fakeDetail(), headSha: "new" });
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(p.prDetail.value?.headSha).toBe("new");
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
  });

  it("a push does not question the detail that just revealed it", async () => {
    // GitLab: the detail reveals the push; the pipeline is still the old head's.
    ghPrChecks.mockResolvedValue(on("abc"));
    const p = await openChecksTab();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "new" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2); // the push's own refetch
    expect(p.checksOtherCommit.value).toBe("abc");
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 2);
    expect(ghPrDetail).toHaveBeenCalledTimes(2); // the detail is the fresh side
  });

  it("two older commits share one follow window and one detail reload", async () => {
    // Azure: two build policies re-queued at different times.
    ghPrChecks
      .mockResolvedValueOnce([check("A", "a1"), check("B", "f3")])
      .mockResolvedValue([check("A", "abc"), check("B", "f3")]);
    const p = await openChecksTab();
    expect(p.checksOtherCommit.value).toBe("a1");
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(p.checksOtherCommit.value).toBe("f3");
    expect(ghPrDetail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(OTHER_COMMIT_FOLLOW_MS);
    const calls = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_SLOW_INTERVAL_MS * 3);
    expect(ghPrChecks).toHaveBeenCalledTimes(calls); // one window, from "a1"
  });

  it("the follow window does not restart when the PR is opened again", async () => {
    // A head that will never get CI ([skip ci]) is not polled anew per visit.
    ghPrChecks.mockResolvedValue(on("old"));
    const p = await openChecksTab();
    await vi.advanceTimersByTimeAsync(OTHER_COMMIT_FOLLOW_MS + CHECKS_LIVE_SLOW_INTERVAL_MS * 2);
    await p.selectPr({ number: 2 } as any);
    await flush();
    await p.selectPr({ number: 1 } as any);
    p.detailTab.value = "checks";
    await flush();
    const n = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks).toHaveBeenCalledTimes(n);
  });

  it("a failed revalidation is retried at the next fetch", async () => {
    ghPrChecks.mockResolvedValueOnce(runningOn("abc")).mockResolvedValue(runningOn("new"));
    const p = await openChecksTab();
    ghPrDetail.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    await flush();
    expect(ghPrDetail).toHaveBeenCalledTimes(2);

    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "new" });
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    // The retry starts once the checks' answer is applied, then runs its fetch.
    await vi.waitFor(() => expect(p.prDetail.value?.headSha).toBe("new"));
    expect(ghPrDetail).toHaveBeenCalledTimes(3);
    expect(p.checksOtherCommit.value).toBeNull();
  });
});
