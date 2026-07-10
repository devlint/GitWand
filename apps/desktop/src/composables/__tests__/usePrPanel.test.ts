import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";

// All of these must be created via `vi.hoisted()`: usePrPanel.ts's import
// chain is long enough that Vitest evaluates the mock factories below before
// a plain top-level `const x = vi.fn()` in this file would have run, throwing
// "Cannot access 'x' before initialization". `vi.hoisted()` guarantees the
// initializers run first regardless of import graph shape.
const { listPRs, createPR, mergePR, getPRCount, ghPrFreshnessSignal } = vi.hoisted(() => ({
  listPRs: vi.fn(),
  createPR: vi.fn(),
  mergePR: vi.fn(),
  getPRCount: vi.fn(),
  ghPrFreshnessSignal: vi.fn(),
}));

vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(async () => null),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
  ghPrFreshnessSignal: (...args: unknown[]) => ghPrFreshnessSignal(...args),
}));

vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs, createPR, mergePR, getPRCount })),
  githubProvider: { name: "github", listPRs, createPR, mergePR, getPRCount },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";

function makePr(n: number) {
  return {
    number: n, title: `PR ${n}`, state: "open", author: "me", branch: `feat-${n}`,
    base: "main", draft: false, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${n}`, additions: 0,
    deletions: 0, labels: [], assignees: [], reviewRequested: [], reviewDecision: "",
    mergeStateStatus: "", checksRollup: "", commentCount: 0,
  };
}

/** Simulates the Rust layer's naive `offset+limit` pagination over `total` PRs. */
function pagedListPRs(total: number) {
  return vi.fn(async (_cwd: string, opts: { limit: number; offset: number }) => {
    const { limit, offset } = opts;
    if (offset >= total) return [];
    const count = Math.min(limit, total - offset);
    return Array.from({ length: count }, (_, i) => makePr(offset + i + 1));
  });
}

describe("usePrPanel — background prefetch drain", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    createPR.mockReset();
    mergePR.mockReset();
    getPRCount.mockReset();
    ghPrFreshnessSignal.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains beyond the first PAGE_SIZE=10 page in the background", async () => {
    listPRs.mockImplementation(pagedListPRs(45));
    const panel = usePrPanel(ref("/repo"));
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(panel.hasMore.value).toBe(true);

    await vi.advanceTimersByTimeAsync(40); // one whenIdle() tick → a BG_PAGE=100 hop

    expect(panel.prs.value).toHaveLength(45);
    expect(panel.hasMore.value).toBe(false);
  });

  it("stops the drain when the repo changes mid-prefetch", async () => {
    listPRs.mockImplementation(pagedListPRs(500));
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(listPRs).toHaveBeenCalledTimes(1);

    cwd.value = "/repo-b";
    await nextTick(); // let the cwd watcher reset state before the drain resumes
    await vi.advanceTimersByTimeAsync(40);

    // The stale prefetch for /repo-a must not issue a second call.
    expect(listPRs).toHaveBeenCalledTimes(1);
  });

  it("stops the drain after an A→B→A round-trip during an in-flight prefetch", async () => {
    listPRs.mockImplementation(pagedListPRs(500));
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(listPRs).toHaveBeenCalledTimes(1);

    // Round-trip back to /repo-a before the in-flight prefetch's whenIdle()
    // resolves. The cwd watcher must invalidate the original loop's token on
    // *both* hops, so cwd.value being back to "/repo-a" alone isn't enough
    // for the stale loop's `live()` check to pass.
    cwd.value = "/repo-b";
    await nextTick();
    cwd.value = "/repo-a";
    await nextTick();

    await vi.advanceTimersByTimeAsync(40);

    // The original repo-a prefetch loop must not resume issuing fetches.
    expect(listPRs).toHaveBeenCalledTimes(1);
  });

  it("restores instantly from the in-memory cache when the freshness signal is unchanged", async () => {
    listPRs.mockImplementation(pagedListPRs(15));
    ghPrFreshnessSignal.mockResolvedValue({ number: 15, updatedAt: "t1", openCount: 15 });
    const panel = usePrPanel(ref("/repo"));

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40); // drain completes, cache is written
    expect(panel.prs.value).toHaveLength(15);
    const callsAfterFirstDrain = listPRs.mock.calls.length;

    await panel.ensurePrsLoaded(); // e.g. branch popover reopened
    expect(panel.prs.value).toHaveLength(15);
    expect(listPRs.mock.calls.length).toBe(callsAfterFirstDrain); // no new fetch — restored from cache
    // Called twice total: once when prefetchOpenPrs() wrote the cache after
    // the first drain, once for this second call's freshness recheck.
    expect(ghPrFreshnessSignal).toHaveBeenCalledTimes(2);
  });

  it("redrains when the freshness signal changes (e.g. a PR opened elsewhere)", async () => {
    listPRs.mockImplementation(pagedListPRs(15));
    ghPrFreshnessSignal.mockResolvedValue({ number: 15, updatedAt: "t1", openCount: 15 });
    const panel = usePrPanel(ref("/repo"));

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);
    expect(panel.prs.value).toHaveLength(15);

    listPRs.mockImplementation(pagedListPRs(16));
    ghPrFreshnessSignal.mockResolvedValue({ number: 16, updatedAt: "t2", openCount: 16 });

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);
    expect(panel.prs.value).toHaveLength(16);
  });

  it("createPr() invalidates the cache so the next ensurePrsLoaded() redrains", async () => {
    listPRs.mockImplementation(pagedListPRs(15));
    ghPrFreshnessSignal.mockResolvedValue({ number: 15, updatedAt: "t1", openCount: 15 });
    const panel = usePrPanel(ref("/repo"));

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);
    expect(panel.prs.value).toHaveLength(15);

    createPR.mockResolvedValue(makePr(16));
    panel.newPrTitle.value = "New PR";
    listPRs.mockImplementation(pagedListPRs(16)); // the repo now has 16 open PRs
    await panel.createPr();
    const callsAfterCreate = listPRs.mock.calls.length;

    ghPrFreshnessSignal.mockResolvedValue({ number: 16, updatedAt: "t2", openCount: 16 });
    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);

    // A stale pre-createPr cache entry must NOT be trusted — it must redrain.
    expect(listPRs.mock.calls.length).toBeGreaterThan(callsAfterCreate);
    expect(panel.prs.value).toHaveLength(16);
  });

  it("refreshDockPrCount() populates dockPrCount from the forge's getPRCount", async () => {
    getPRCount.mockResolvedValue(7);
    const panel = usePrPanel(ref("/repo"));
    expect(panel.dockPrCount.value).toBeNull();
    await panel.refreshDockPrCount();
    expect(panel.dockPrCount.value).toBe(7);
    expect(getPRCount).toHaveBeenCalledWith("/repo", "open");
  });

  it("refreshDockPrCount() resolves to 0 instead of throwing when getPRCount rejects", async () => {
    getPRCount.mockRejectedValue(new Error("network down"));
    const panel = usePrPanel(ref("/repo"));
    await panel.refreshDockPrCount();
    expect(panel.dockPrCount.value).toBe(0);
  });

  it("switching repos resets dockPrCount and triggers a fresh refresh for the new repo", async () => {
    getPRCount.mockResolvedValue(3);
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    await panel.refreshDockPrCount();
    expect(panel.dockPrCount.value).toBe(3);

    getPRCount.mockResolvedValue(9);
    cwd.value = "/repo-b";
    await nextTick(); // flush the cwd watcher
    await nextTick(); // flush the watcher's own fire-and-forget refreshDockPrCount() call

    expect(getPRCount).toHaveBeenCalledWith("/repo-b", "open");
    expect(panel.dockPrCount.value).toBe(9);
  });

  it("discards a stale getPRCount result if the repo changed before it resolved", async () => {
    let resolveA!: (n: number) => void;
    const pendingA = new Promise<number>((resolve) => { resolveA = resolve; });
    getPRCount.mockImplementationOnce(() => pendingA); // repo-a's call: stays pending
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    void panel.refreshDockPrCount(); // fire, in flight, not yet resolved

    getPRCount.mockResolvedValueOnce(9); // repo-b's call: resolves immediately
    cwd.value = "/repo-b";
    await nextTick(); // flush the cwd watcher, which resets dockPrCount and fires its own refresh for repo-b
    await nextTick(); // let repo-b's refresh resolve and apply
    expect(panel.dockPrCount.value).toBe(9);

    resolveA(3); // repo-a's stale call finally resolves, after repo-b already applied
    await nextTick();
    await nextTick();

    // Must NOT have been overwritten by the late, stale repo-a result.
    expect(panel.dockPrCount.value).toBe(9);
  });
});
