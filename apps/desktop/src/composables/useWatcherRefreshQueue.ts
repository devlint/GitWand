/**
 * useWatcherRefreshQueue - serializes watcher-driven refreshes (v3.10.0 Phase C).
 *
 * An `rm -rf node_modules` or a branch switch produces several coalesced
 * batches back to back, and repoRefresh() routinely takes longer than the
 * watcher's 150ms debounce window — so without a guard, a burst of events
 * would stack N concurrent refreshes on the same repo.
 *
 * `schedule` is keyed rather than a bare in-flight boolean: distinct callers
 * (worktree/index, head/refs, mergeState, stash, ...) must each still run
 * once an in-flight refresh finishes, not just whichever one happened to be
 * on the stack when it did. A single event batch can carry several kinds at
 * once (`useRepoWatcher.dispatch` fires every matching registration
 * synchronously off one event), so two distinct handlers routinely queue
 * during the very same in-flight window. Repeated events under the *same*
 * key while busy collapse to the latest closure — they do equivalent work,
 * so only the freshest one needs to actually run.
 */
export interface WatcherRefreshQueue {
  schedule: (key: string, run: () => Promise<void>) => void;
}

export function useWatcherRefreshQueue(): WatcherRefreshQueue {
  let inFlight: Promise<void> | null = null;
  const queue = new Map<string, () => Promise<void>>();

  function schedule(key: string, run: () => Promise<void>) {
    if (typeof document !== "undefined" && document.hidden) return;
    if (inFlight) {
      queue.set(key, run);
      return;
    }
    inFlight = run()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
        if (queue.size > 0) {
          const pending = [...queue.entries()];
          queue.clear();
          for (const [pendingKey, pendingRun] of pending) {
            schedule(pendingKey, pendingRun);
          }
        }
      });
  }

  return { schedule };
}
