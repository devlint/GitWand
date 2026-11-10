// @vitest-environment jsdom
/**
 * The CI tab follows a running CI: while it is shown and a check is still
 * running, the checks are re-fetched every 15 s; polling stops once every
 * check has finished, and the PR detail is then revalidated once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope } from "vue";
import { usePrCache, listKey, _resetPrCacheForTesting } from "../usePrCache";

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
  CHECKS_AWAIT_AFTER_PUSH_MS,
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

  it("updates the PR list entry's CI rollup when the last check finishes", async () => {
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any, { number: 9, checksRollup: "PENDING" } as any];
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(p.prs.value.find((x: any) => x.number === 1)?.checksRollup).toBe("SUCCESS");
    expect(p.prs.value.find((x: any) => x.number === 9)?.checksRollup).toBe("PENDING");
  });

  it("sets the rollup to FAILURE when a finished check failed", async () => {
    const failed = [{ name: "build", state: "COMPLETED", conclusion: "FAILURE", detailsUrl: "" }];
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(failed);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(p.prs.value[0].checksRollup).toBe("FAILURE");
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

  it("sets the list rollup to PENDING when a finished list still has an expired check", async () => {
    const expired = [
      { name: "build", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "" },
      { name: "old", state: "COMPLETED", conclusion: "EXPIRED", detailsUrl: "" },
    ];
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(expired);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(p.prs.value[0].checksRollup).toBe("PENDING");
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
    expect(ghPrChecks.mock.calls.length).toBe(before + 1);
  });

  it("after a push, keeps polling the CI tab until the new head's checks appear", async () => {
    ghPrChecks.mockResolvedValueOnce(done).mockResolvedValueOnce([]).mockResolvedValue(running);
    const p = await openChecksTab();
    expect(p.prChecks.value).toEqual(done);
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    expect(ghPrChecks).toHaveBeenCalledTimes(2);
    expect(p.prChecks.value).toEqual([]); // not registered yet
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(p.prChecks.value).toEqual(running);
  });

  it("stops waiting for the new head's checks after a while", async () => {
    ghPrChecks.mockResolvedValueOnce(done).mockResolvedValue([]);
    const p = await openChecksTab();
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), headSha: "def" });
    await p.revalidateOpenDetail();
    await flush();
    await vi.advanceTimersByTimeAsync(CHECKS_AWAIT_AFTER_PUSH_MS + CHECKS_LIVE_INTERVAL_MS);
    const n = ghPrChecks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS * 4);
    expect(ghPrChecks.mock.calls.length).toBe(n);
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

  it("leaves the list row alone when only skipped checks remain", async () => {
    const skipped = [{ name: "b", state: "COMPLETED", conclusion: "SKIPPED", detailsUrl: "" }];
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(skipped);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(p.prs.value[0].checksRollup).toBe("PENDING");
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

  it("updates the cached PR lists too when the last check finishes", async () => {
    _resetPrCacheForTesting();
    const cache = usePrCache();
    cache.setList(listKey("/repo", "open"), [{ number: 1, checksRollup: "PENDING" } as any], false);
    ghPrChecks.mockResolvedValueOnce(running).mockResolvedValue(done);
    const p = await openChecksTab();
    p.prs.value = [{ number: 1, checksRollup: "PENDING" } as any];
    await vi.advanceTimersByTimeAsync(CHECKS_LIVE_INTERVAL_MS);
    expect(cache.getList(listKey("/repo", "open"))?.prs[0].checksRollup).toBe("SUCCESS");
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
