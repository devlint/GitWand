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
      try {
        const id = await watchRepoStart(path, dispatch);
        if (generation !== _generation) {
          // The folder changed while start() was in flight: drop this one.
          void watchRepoStop(id);
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
