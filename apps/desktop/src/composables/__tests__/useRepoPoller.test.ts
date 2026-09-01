import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const gitExecMock = vi.fn();
vi.mock("../../utils/backend", () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
}));

import { useRepoPoller } from "../useRepoPoller";

function actions() {
  return {
    onStatusChange: vi.fn(async () => {}),
    onConflictDetected: vi.fn(async () => {}),
    onFetchTick: vi.fn(async () => {}),
    onNightlyTick: vi.fn(async () => {}),
    onConnectivityTick: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  gitExecMock.mockReset();
  gitExecMock.mockResolvedValue({ exitCode: 0, stdout: "## main\n" });
});
afterEach(() => { vi.useRealTimers(); });

describe("useRepoPoller cadences", () => {
  it("fires onFetchTick about every 30 s at the fast interval", async () => {
    const a = actions();
    const p = useRepoPoller(a);
    p.setFolderPath("/tmp/repo");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(a.onFetchTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.onFetchTick).toHaveBeenCalledTimes(1);
  });

  it("keeps the 30 s fetch cadence after demoting to the slow interval", async () => {
    const a = actions();
    const p = useRepoPoller(a);
    p.setFolderPath("/tmp/repo");
    p.setWatcherHealthy(true);
    // Two slow ticks = 30 s of wall clock: the fetch must have fired once,
    // not once per 15 "ticks" (which would be 225 s).
    await vi.advanceTimersByTimeAsync(31_000);
    expect(a.onFetchTick).toHaveBeenCalledTimes(1);
  });

  it("polls status less often once a watcher is healthy", async () => {
    const a = actions();
    const p = useRepoPoller(a);
    p.setFolderPath("/tmp/repo");
    gitExecMock.mockClear();
    p.setWatcherHealthy(true);
    await vi.advanceTimersByTimeAsync(30_000);
    // 30 s at 15 s = 2 status probes, versus 15 at the fast interval.
    expect(gitExecMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("returns to the fast interval and probes immediately when the watcher dies", async () => {
    const a = actions();
    const p = useRepoPoller(a);
    p.setFolderPath("/tmp/repo");
    p.setWatcherHealthy(true);
    await vi.advanceTimersByTimeAsync(1_000);
    gitExecMock.mockClear();
    p.setWatcherHealthy(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(gitExecMock).toHaveBeenCalledTimes(1); // eager tick
    await vi.advanceTimersByTimeAsync(4_100);
    expect(gitExecMock.mock.calls.length).toBeGreaterThanOrEqual(3); // 2 s cadence resumed
  });
});
