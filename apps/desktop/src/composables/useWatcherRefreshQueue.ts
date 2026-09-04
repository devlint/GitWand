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
 *
 * Hidden tab: work is *queued*, never dropped. The backend keeps watching
 * while the window is in the background, so a merge started in a terminal, a
 * branch switch or a stash still arrives, it just must not run a refresh
 * against a tab nobody is looking at. Dropping it instead (the original
 * behaviour) lost two things: refreshes already queued behind an in-flight
 * one when the tab was backgrounded, and every kind whose caller had no
 * resume catch-up of its own, `mergeState`'s auto-resolve hand-off among
 * them. Draining on `visibilitychange` needs no cooperation from callers.
 */
import { getCurrentInstance, onUnmounted } from "vue";

export interface WatcherRefreshQueue {
  schedule: (key: string, run: () => Promise<void>) => void;
}

export function useWatcherRefreshQueue(): WatcherRefreshQueue {
  let inFlight: Promise<void> | null = null;
  /** Pending work, at most one closure per key (latest wins). */
  const queue = new Map<string, () => Promise<void>>();

  function isHidden(): boolean {
    return typeof document !== "undefined" && document.hidden;
  }

  /** Start the next queued refresh if one may run right now. */
  function pump() {
    if (inFlight || isHidden()) return;
    const next = queue.entries().next();
    if (next.done) return;
    const [key, run] = next.value;
    queue.delete(key);
    inFlight = run()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
        pump();
      });
  }

  function schedule(key: string, run: () => Promise<void>) {
    queue.set(key, run);
    pump();
  }

  let visibilityHandler: (() => void) | null = null;
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (!document.hidden) pump();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }
  if (getCurrentInstance()) {
    onUnmounted(() => {
      if (typeof document !== "undefined" && visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
    });
  }

  return { schedule };
}
