import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";

const { getPRCount } = vi.hoisted(() => ({
  getPRCount: vi.fn(),
}));

vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(async () => null),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
  ghPrFreshnessSignal: vi.fn(),
  detectClaudeCli: vi.fn(async () => ({
    found: false, path: "", version: "", logged_in: false, status: "not_found",
  })),
}));

vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", getPRCount })),
  githubProvider: { name: "github", getPRCount },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";

describe("usePrPanel — dock badge throttle (Phase C)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    getPRCount.mockReset();
    getPRCount.mockResolvedValue(3);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses two calls within the 60s gap into a single forge call", async () => {
    const panel = usePrPanel(ref("/repo"));

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);
  });

  it("calls through again once the gap has elapsed", async () => {
    vi.useFakeTimers();
    const panel = usePrPanel(ref("/repo"));

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(2);
  });

  it("force always calls through, bypassing the throttle", async () => {
    const panel = usePrPanel(ref("/repo"));

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);

    await panel.refreshDockPrCountThrottled(true);
    expect(getPRCount).toHaveBeenCalledTimes(2);
  });

  it("fetches once on a repo change and throttles the events that follow", async () => {
    vi.useFakeTimers();
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);

    cwd.value = "/repo-b";
    // The cwd watcher resets the throttle and fires its own forced repo-open
    // refresh; wait for it to land (it awaits loadRemote() first).
    await vi.waitFor(() => expect(getPRCount).toHaveBeenCalledTimes(2));

    // That refresh stamps the window like any other real call, so the first
    // watcher `refs` event right after a repo change no longer fires a second,
    // redundant forge call for a count we just fetched.
    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(3);
  });

  /**
   * The window must be spent on calls that actually produced a count. A forge
   * call that fails (offline, no token, rate limit) leaves the badge stale,
   * so the next `refs` event has to be allowed through, stamping up front
   * skipped it for a full minute for nothing.
   */
  it("does not spend the throttle window on a failed forge call", async () => {
    const panel = usePrPanel(ref("/repo"));
    getPRCount.mockRejectedValueOnce(new Error("offline"));

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(2);
  });

  it("does not let two refreshes race through the throttle at once", async () => {
    const panel = usePrPanel(ref("/repo"));
    let release!: (v: number) => void;
    getPRCount.mockImplementationOnce(() => new Promise((r) => { release = r; }));

    const first = panel.refreshDockPrCountThrottled();
    const second = panel.refreshDockPrCountThrottled(); // while the first is in flight
    // The forge call only goes out after loadRemote() resolves.
    await vi.waitFor(() => expect(getPRCount).toHaveBeenCalledTimes(1));
    release(7);
    await Promise.all([first, second]);

    expect(getPRCount).toHaveBeenCalledTimes(1);
  });
});
