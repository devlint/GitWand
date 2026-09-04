/**
 * useRepoWatcher - Live Repo filesystem subscription (v3.10.0).
 *
 * Owns exactly one backend watch subscription for the active repo and fans
 * coalesced change events out to registered handlers. `healthy` drives the
 * poll demotion in useRepoPoller: when this is false (watcher unsupported,
 * network mount, backend error) the poller stays on its fast cadence.
 */
import { getCurrentInstance, onUnmounted, ref, type Ref } from "vue";
import { watchRepoStart, watchRepoStop, type RepoChangeEvent } from "../utils/backend";

export type RepoChangeKind =
  | "head" | "index" | "refs" | "config" | "mergeState" | "stash" | "worktree";

export interface RepoWatcherApi {
  /** True while a subscription is live and has not errored. */
  healthy: Ref<boolean>;
  /** Point the watcher at a repo, or null to stop watching. */
  setFolderPath: (path: string | null) => void;
  /** Register a handler for a set of kinds. Returns an unsubscribe fn. */
  on: (kinds: RepoChangeKind[], handler: (ev: RepoChangeEvent) => void) => () => void;
}

interface Registration {
  kinds: Set<string>;
  handler: (ev: RepoChangeEvent) => void;
}

export function useRepoWatcher(opts?: { onHealthChange?: (healthy: boolean) => void }): RepoWatcherApi {
  const healthy = ref(false);
  const registrations = new Set<Registration>();

  let _folderPath: string | null = null;
  let _subscriptionId: number | null = null;
  /** Guards against a slow start() resolving after the folder already changed. */
  let _generation = 0;

  function setHealthy(value: boolean) {
    if (healthy.value === value) return;
    healthy.value = value;
    opts?.onHealthChange?.(value);
  }

  function dispatch(ev: RepoChangeEvent) {
    for (const reg of registrations) {
      const matches = ev.truncated || ev.kinds.some((k) => reg.kinds.has(k));
      if (!matches) continue;
      try {
        reg.handler(ev);
      } catch (err) {
        console.warn("[gitwand] repo watcher handler threw", err);
      }
    }
  }

  async function stop() {
    const id = _subscriptionId;
    _subscriptionId = null;
    setHealthy(false);
    if (id !== null) {
      try { await watchRepoStop(id); } catch { /* teardown is best-effort */ }
    }
  }

  function setFolderPath(path: string | null) {
    if (path === _folderPath) return;
    _folderPath = path;
    const generation = ++_generation;
    void stop().then(async () => {
      if (!path || generation !== _generation) return;
      // `startedId` is deliberately a mutable binding assigned *after* the
      // await, not a `const id` captured by the close callback: both backends
      // install the event handler before the call that yields the id resolves
      // (`watchRepoStart` sets `channel.onmessage` before invoking
      // `watch_repo_start`; the dev path opens the SSE stream first). A watch
      // that dies immediately (deleted/unmounted directory, fatal notify
      // backend error, dev server restart) therefore delivers its
      // `closed: true` sentinel while the await is still pending. Reading a
      // `const id` from inside the callback at that point would throw a TDZ
      // ReferenceError inside the channel handler, leaving `healthy` stuck at
      // true on a subscription the backend has already purged (and the poller
      // demoted to its 15 s fallback with no events coming).
      let startedId: number | null = null;
      let closedBeforeStart = false;
      const onClose = () => {
        if (startedId === null) {
          // Closed before the id landed: remember it, `start` handles it below.
          closedBeforeStart = true;
          return;
        }
        // A stale close from a since-replaced subscription is a no-op:
        // `startedId` no longer matches `_subscriptionId`.
        if (startedId === _subscriptionId) {
          _subscriptionId = null;
          setHealthy(false);
        }
      };
      try {
        const id: number = await watchRepoStart(path, dispatch, onClose);
        if (generation !== _generation) {
          // The folder changed while start() was in flight: drop this one.
          void watchRepoStop(id);
          return;
        }
        startedId = id;
        if (closedBeforeStart) {
          // The watch died before `watch_repo_start` even returned. Never
          // report healthy: there is nothing alive behind this id.
          _subscriptionId = null;
          healthy.value = false;
          opts?.onHealthChange?.(false);
          void watchRepoStop(id); // idempotent on both backends
          return;
        }
        _subscriptionId = id;
        setHealthy(true);
      } catch (err) {
        console.warn("[gitwand] filesystem watcher unavailable, staying on poll fallback", err);
        // Always notify on a failed start attempt, even though `healthy` was
        // already false: setHealthy()'s no-change guard would otherwise
        // swallow this callback on the very first attempt.
        healthy.value = false;
        opts?.onHealthChange?.(false);
      }
    });
  }

  function on(kinds: RepoChangeKind[], handler: (ev: RepoChangeEvent) => void): () => void {
    const reg: Registration = { kinds: new Set<string>(kinds), handler };
    registrations.add(reg);
    return () => { registrations.delete(reg); };
  }

  if (getCurrentInstance()) {
    onUnmounted(() => { void stop(); });
  }

  return { healthy, setFolderPath, on };
}
