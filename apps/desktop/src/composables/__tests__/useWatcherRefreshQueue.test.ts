// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useWatcherRefreshQueue } from "../useWatcherRefreshQueue";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useWatcherRefreshQueue", () => {
  // Regression test: a single coalesced batch can carry several kinds at
  // once (e.g. a conflicting `git merge` fires "worktree"+"index"+"mergeState"
  // together), and useRepoWatcher.dispatch fires every matching registration
  // synchronously off that one event — so two *distinct* handlers routinely
  // queue during the same in-flight window. A shared boolean "something is
  // queued" flag only remembers one of them; this must not happen.
  it("runs every distinct handler queued during an in-flight window, not just one", async () => {
    const q = useWatcherRefreshQueue();
    const first = deferred();
    const runA = vi.fn(() => first.promise);
    const runB = vi.fn(async () => {});
    const runC = vi.fn(async () => {});

    q.schedule("a", runA); // starts immediately, stays in-flight until resolved
    expect(runA).toHaveBeenCalledTimes(1);

    q.schedule("b", runB); // queued while "a" is in flight
    q.schedule("c", runC); // queued while "a" is in flight
    expect(runB).not.toHaveBeenCalled();
    expect(runC).not.toHaveBeenCalled();

    first.resolve();
    await vi.waitFor(() => expect(runB).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runC).toHaveBeenCalledTimes(1));
  });

  it("never runs two refreshes concurrently", async () => {
    const q = useWatcherRefreshQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const make = () => vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      await Promise.resolve();
      concurrent--;
    });
    const runA = make();
    const runB = make();
    const runC = make();

    q.schedule("a", runA);
    q.schedule("b", runB);
    q.schedule("c", runC);

    await vi.waitFor(() => expect(runC).toHaveBeenCalledTimes(1));
    expect(maxConcurrent).toBe(1);
  });

  it("collapses repeated events under the same key while busy to the latest closure", async () => {
    const q = useWatcherRefreshQueue();
    const first = deferred();
    const runA = vi.fn(() => first.promise);
    q.schedule("x", runA);

    const stale = vi.fn(async () => {});
    const fresh = vi.fn(async () => {});
    q.schedule("y", stale);
    q.schedule("y", fresh); // overwrites the still-queued "y" entry

    first.resolve();
    await vi.waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));
    expect(stale).not.toHaveBeenCalled();
  });

  it("does not schedule while the document is hidden", () => {
    const q = useWatcherRefreshQueue();
    const spy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const run = vi.fn(async () => {});
    q.schedule("a", run);
    expect(run).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
