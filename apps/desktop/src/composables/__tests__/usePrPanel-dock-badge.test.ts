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

  it("resets the throttle when the repo (cwd) changes", async () => {
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);

    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);

    cwd.value = "/repo-b";
    // The cwd watcher fires its own unthrottled repo-open refresh; wait for
    // it to actually land (it awaits loadRemote() first) before clearing.
    await vi.waitFor(() => expect(getPRCount).toHaveBeenCalledTimes(2));
    getPRCount.mockClear();

    // Without the reset this would be throttled to zero calls (< 60s elapsed).
    await panel.refreshDockPrCountThrottled();
    expect(getPRCount).toHaveBeenCalledTimes(1);
  });
});
