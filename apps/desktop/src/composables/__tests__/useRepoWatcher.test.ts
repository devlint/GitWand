import { describe, it, expect, vi, beforeEach } from "vitest";

const startMock = vi.fn();
const stopMock = vi.fn();
vi.mock("../../utils/backend", () => ({
  watchRepoStart: (...args: unknown[]) => startMock(...args),
  watchRepoStop: (...args: unknown[]) => stopMock(...args),
}));

import { useRepoWatcher } from "../useRepoWatcher";

/** Capture the onChange callback handed to watchRepoStart so tests can fire events. */
let emit: (ev: { kinds: string[]; paths: string[]; truncated: boolean }) => void;

beforeEach(() => {
  startMock.mockReset();
  stopMock.mockReset();
  startMock.mockImplementation(async (_cwd: string, onChange: typeof emit) => {
    emit = onChange;
    return 7;
  });
  stopMock.mockResolvedValue(undefined);
});

describe("useRepoWatcher", () => {
  it("starts a subscription and reports healthy", async () => {
    const w = useRepoWatcher();
    w.setFolderPath("/tmp/repo");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect(startMock.mock.calls[0][0]).toBe("/tmp/repo");
    await vi.waitFor(() => expect(w.healthy.value).toBe(true));
  });

  it("routes an event only to handlers whose kinds intersect", async () => {
    const w = useRepoWatcher();
    w.setFolderPath("/tmp/repo");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalled());
    const onWorktree = vi.fn();
    const onRefs = vi.fn();
    w.on(["worktree", "index"], onWorktree);
    w.on(["refs"], onRefs);
    emit({ kinds: ["worktree"], paths: ["a.txt"], truncated: false });
    expect(onWorktree).toHaveBeenCalledTimes(1);
    expect(onRefs).not.toHaveBeenCalled();
  });

  it("delivers a truncated batch to every handler regardless of kinds", async () => {
    const w = useRepoWatcher();
    w.setFolderPath("/tmp/repo");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalled());
    const onRefs = vi.fn();
    w.on(["refs"], onRefs);
    emit({ kinds: ["worktree"], paths: [], truncated: true });
    expect(onRefs).toHaveBeenCalledTimes(1);
  });

  it("keeps other handlers running when one throws", async () => {
    const w = useRepoWatcher();
    w.setFolderPath("/tmp/repo");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalled());
    const good = vi.fn();
    w.on(["worktree"], () => { throw new Error("boom"); });
    w.on(["worktree"], good);
    emit({ kinds: ["worktree"], paths: [], truncated: false });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("stops the previous subscription when the folder changes", async () => {
    const w = useRepoWatcher();
    w.setFolderPath("/tmp/a");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    w.setFolderPath("/tmp/b");
    await vi.waitFor(() => expect(stopMock).toHaveBeenCalledWith(7));
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(2));
  });

  it("reports unhealthy when the backend refuses to start a watch", async () => {
    startMock.mockRejectedValueOnce(new Error("no watcher"));
    const onHealthChange = vi.fn();
    const w = useRepoWatcher({ onHealthChange });
    w.setFolderPath("/tmp/repo");
    await vi.waitFor(() => expect(onHealthChange).toHaveBeenCalledWith(false));
    expect(w.healthy.value).toBe(false);
  });

  it("reports unhealthy when the underlying connection drops mid-session", async () => {
    let close: (() => void) | undefined;
    startMock.mockImplementationOnce(async (_cwd: string, onChange: typeof emit, onClose: () => void) => {
      emit = onChange;
      close = onClose;
      return 7;
    });
    const onHealthChange = vi.fn();
    const w = useRepoWatcher({ onHealthChange });
    w.setFolderPath("/tmp/repo");
    await vi.waitFor(() => expect(w.healthy.value).toBe(true));
    onHealthChange.mockClear();
    close?.();
    expect(onHealthChange).toHaveBeenCalledWith(false);
    expect(w.healthy.value).toBe(false);
  });

  /**
   * Both backends install the change/close handler *before* the call that
   * yields the subscription id resolves, so a watch that dies instantly
   * (deleted or unmounted directory, fatal notify backend error, dev server
   * restart) delivers its close while `watchRepoStart` is still pending. The
   * handler runs isolated from that promise in production (Tauri dispatches
   * `channel.onmessage`; the dev path dispatches an SSE message), so a throw
   * inside it does not reject the start, it just silently wedges the watcher
   * with `healthy` stuck at true. The mock reproduces that isolation.
   */
  it("never reports healthy when the watch dies before start resolves", async () => {
    let closeThrew: unknown = null;
    startMock.mockImplementationOnce(async (_cwd: string, onChange: typeof emit, onClose: () => void) => {
      emit = onChange;
      try { onClose(); } catch (err) { closeThrew = err; }
      return 7;
    });
    const onHealthChange = vi.fn();
    const w = useRepoWatcher({ onHealthChange });
    w.setFolderPath("/tmp/repo");

    await vi.waitFor(() => expect(onHealthChange).toHaveBeenCalledWith(false));
    expect(closeThrew).toBeNull();
    expect(w.healthy.value).toBe(false);
    expect(onHealthChange).not.toHaveBeenCalledWith(true);
    // The dead subscription is released rather than leaked.
    await vi.waitFor(() => expect(stopMock).toHaveBeenCalledWith(7));
  });

  it("ignores a stale close from a subscription already replaced by a folder switch", async () => {
    const closes: Array<() => void> = [];
    let nextId = 0;
    startMock.mockImplementation(async (_cwd: string, onChange: typeof emit, onClose: () => void) => {
      emit = onChange;
      closes.push(onClose);
      return ++nextId;
    });
    const onHealthChange = vi.fn();
    const w = useRepoWatcher({ onHealthChange });

    // Subscribe to path A, then switch to path B before A's close arrives —
    // the exact race a mid-flight watcher death can hit.
    w.setFolderPath("/tmp/a");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(w.healthy.value).toBe(true));

    w.setFolderPath("/tmp/b");
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(w.healthy.value).toBe(true));

    onHealthChange.mockClear();
    closes[0]?.(); // stale close for A, arriving after the switch to B
    expect(onHealthChange).not.toHaveBeenCalled();
    expect(w.healthy.value).toBe(true);
  });
});
