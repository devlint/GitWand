/**
 * useRepoPoller — Consolidated git poll manager (§2.1).
 *
 * Replaces 5 independent setInterval calls (pollStatus 2s, fetchRemote 30s,
 * refreshRepoState 3s, autoResolve 5s, nightlyPull 60s) with a single 2s
 * interval that orchestrates all of them.
 *
 * Design:
 *   - One setInterval at FAST_INTERVAL (2 s), demoted to SLOW_INTERVAL (15 s)
 *     while a filesystem watcher is healthy (v3.10.0)
 *   - Lightweight git status --porcelain --branch every tick
 *   - Expensive ops (fetch, full status parse) only when porcelain output changes
 *   - Visibility-aware: pauses on document.hidden, resumes + eager check on return
 *   - Wall-clock deadlines for 30s (fetch) and 60s (nightly pull) cadences,
 *     independent of the current interval
 *   - Derived conflict detection from porcelain output (replaces autoResolve's
 *     separate getGitStatus call)
 *
 * Usage in App.vue:
 *   const poller = useRepoPoller({
 *     onStatusChange: async (cwd) => {
 *       await repo.loadStatus(cwd);
 *       if (repo.selectedFilePath.value) await repo.loadDiff(...);
 *     },
 *     onConflictDetected: async (cwd) => { ... },
 *     onFetchTick: async (cwd) => { ... },
 *     onNightlyTick: async () => { ... },
 *   });
 *   watch(repoFolderPath, (p) => poller.setFolderPath(p));
 */

import { onUnmounted } from "vue";
import { gitExec } from "../utils/backend";

// ─── Constants ───────────────────────────────────────────────

/** Poll interval while no filesystem watcher is healthy. */
const FAST_INTERVAL = 2_000;
/** Poll interval while a watcher is healthy: a safety net, not the primary driver. */
const SLOW_INTERVAL = 15_000;
/** Wall-clock cadences, independent of the current interval. */
const FETCH_EVERY_MS = 30_000;
const NIGHTLY_EVERY_MS = 60_000;
const CONNECTIVITY_EVERY_MS = 30_000;

// ─── Public interface ───────────────────────────────────────

export interface RepoPollerActions {
  /** Called when porcelain output changed → consumer should reload full status. */
  onStatusChange: (cwd: string) => Promise<void>;
  /**
   * Called on the rising edge of conflict detection (porcelain went from
   * no `UU` entries to at least one). Replaces autoResolve's standalone
   * poll — the consumer should check settings before acting.
   */
  onConflictDetected: (cwd: string) => Promise<void>;
  /** Called every ~30 s for background fetch + subsequent status refresh. */
  onFetchTick: (cwd: string) => Promise<void>;
  /** Called every ~60 s to check nightly-pull schedule. */
  onNightlyTick: () => Promise<void>;
  /**
   * Called every ~30 s with the active repo path so the connectivity probe
   * can decide whether to flip the app into offline mode (F1).
   * Optional — callers that don't care about connectivity can omit it.
   */
  onConnectivityTick?: (cwd: string) => Promise<void>;
}

// ─── Composable ─────────────────────────────────────────────

export function useRepoPoller(actions: RepoPollerActions) {
  let _folderPath: string | null = null;
  let _interval: ReturnType<typeof setInterval> | null = null;
  let _intervalMs = FAST_INTERVAL;
  let _watcherHealthy = false;
  let _lastFetchAt = 0;
  let _lastNightlyAt = 0;
  let _lastConnectivityAt = 0;
  let _porcelainSnapshot = "";
  let _conflictWasPresent = false;
  let _visibilityHandler: (() => void) | null = null;

  // ── Visibility ────────────────────────────────────────────
  function isHidden(): boolean {
    return typeof document !== "undefined" && document.hidden;
  }

  function handleVisibilityChange() {
    if (!_folderPath) return;
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
      void tick(true);
    }
  }

  // ── Single tick ───────────────────────────────────────────
  async function tick(eager = false) {
    const cwd = _folderPath;
    if (!cwd) return;
    if (!eager && isHidden()) return;

    // 1. Lightweight porcelain check every tick
    try {
      const result = await gitExec(cwd, ["status", "--porcelain", "--branch"]);
      if (result.exitCode !== 0) return;
      const snapshot = result.stdout ?? "";

      if (snapshot !== _porcelainSnapshot) {
        _porcelainSnapshot = snapshot;
        await actions.onStatusChange(cwd);

        // Conflict detection on rising edge (UU → unresolved)
        const hasConflicts = snapshot
          .split("\n")
          .some((l) => l.startsWith("UU "));
        if (hasConflicts && !_conflictWasPresent) {
          _conflictWasPresent = true;
          await actions.onConflictDetected(cwd);
        } else if (!hasConflicts) {
          _conflictWasPresent = false;
        }
      }
    } catch {
      // polling errors are non-critical — silent
    }

    const now = Date.now();

    // 2. Background fetch, at most every 30 s of wall clock.
    if (now - _lastFetchAt >= FETCH_EVERY_MS) {
      _lastFetchAt = now;
      await actions.onFetchTick(cwd).catch(() => {});
    }

    // 3. Nightly-pull schedule check, at most every 60 s.
    if (now - _lastNightlyAt >= NIGHTLY_EVERY_MS) {
      _lastNightlyAt = now;
      await actions.onNightlyTick().catch(() => {});
    }

    // 4. Connectivity probe, at most every 30 s (F1 offline mode). Rides this
    //    poller's clock so we never add a second interval, per the polling
    //    discipline rule in apps/desktop/CLAUDE.md.
    if (actions.onConnectivityTick && now - _lastConnectivityAt >= CONNECTIVITY_EVERY_MS) {
      _lastConnectivityAt = now;
      await actions.onConnectivityTick(cwd).catch(() => {});
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  function startPolling() {
    if (_interval) return;
    _interval = setInterval(() => void tick(), _intervalMs);
  }

  /** Restart the interval at the current `_intervalMs`. No-op when stopped. */
  function reconcileInterval() {
    if (!_interval) return;
    clearInterval(_interval);
    _interval = null;
    startPolling();
  }

  /**
   * Demote (or restore) the poll cadence. A healthy filesystem watcher makes
   * the poll a fallback for the cases events cannot cover: watcher failure,
   * network mounts, FUSE filesystems.
   */
  function setWatcherHealthy(value: boolean) {
    if (_watcherHealthy === value) return;
    _watcherHealthy = value;
    _intervalMs = value ? SLOW_INTERVAL : FAST_INTERVAL;
    reconcileInterval();
    if (!value) {
      // The watcher just died: whatever it missed, catch it now.
      void tick(true);
    }
  }

  function stopPolling() {
    if (_interval) {
      clearInterval(_interval);
      _interval = null;
    }
  }

  /**
   * Set (or clear) the tracked repo folder. When switching to a new repo,
   * internal state is reset and an eager tick fires immediately.
   * Pass `null` to stop all polling.
   */
  function setFolderPath(path: string | null) {
    if (path === _folderPath) return;
    _folderPath = path;
    if (path) {
      _porcelainSnapshot = "";
      _conflictWasPresent = false;
      _lastFetchAt = Date.now();
      _lastNightlyAt = Date.now();
      _lastConnectivityAt = Date.now();
      startPolling();
      void tick(true);
    } else {
      stopPolling();
    }
  }

  // Visibility listener (single, shared)
  if (typeof document !== "undefined") {
    _visibilityHandler = handleVisibilityChange;
    document.addEventListener("visibilitychange", _visibilityHandler);
  }

  onUnmounted(() => {
    stopPolling();
    if (typeof document !== "undefined" && _visibilityHandler) {
      document.removeEventListener("visibilitychange", _visibilityHandler);
    }
  });

  return { setFolderPath, startPolling, stopPolling, setWatcherHealthy };
}
