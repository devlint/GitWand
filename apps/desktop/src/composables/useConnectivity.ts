/**
 * useConnectivity — module-level connectivity singleton (F1, Mode hors-ligne).
 *
 * Replaces the previous `useNetworkStatus` heuristic (which only listened to
 * `navigator.onLine` and would happily say "online" when the wifi adapter was
 * up but the link was actually dead) with a probe-based signal:
 *
 *   1. Every ~30 s `useRepoPoller` calls `probeConnectivity(cwd)` which:
 *      - resolves the `origin` remote URL of the active repo (skipped when
 *        none — without a remote there's nothing to probe and we stay
 *        optimistic = online)
 *      - opens a bounded TCP connect to that host (see
 *        `checkRemoteReachable` / `commands::network::check_remote_reachable`)
 *      - flips `isOnline` based on the result and logs a single entry on
 *        transitions via `useLogs`
 *
 *   2. `window.online` (the browser's "wifi came back" event) triggers an
 *      immediate eager probe so the UI un-greys network buttons as soon as
 *      the user reconnects — without waiting for the next poll tick.
 *
 *   3. `window.offline` flips `isOnline` to `false` immediately (no probe
 *      needed — the OS just told us the link is down).
 *
 * Singleton: state lives at module scope so every consumer (header pill,
 * SyncSplitButton, networkGuard, App.vue poller) sees the same value
 * without prop drilling.  Initial value is `true` (optimistic) — the first
 * probe will correct it within one tick if the user really is offline.
 *
 * The composable does NOT own a timer of its own — that would re-introduce
 * the polling regression described in `feedback_gitwand_polling_discipline`.
 * `useRepoPoller` is the single 2 s heartbeat for the whole app; it calls
 * us through `onConnectivityTick`.
 */

import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { checkRemoteReachable, gitRemoteInfo } from "../utils/backend";
import { useLogs } from "./useLogs";

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Consecutive failed probes required before we flip the *display* flag to
 * offline. A single dropped probe (2 s timeout under load, a DNS hiccup) must
 * not light the "Offline" pill — only a sustained failure does. Recovery is
 * asymmetric: one success flips us back online immediately.
 */
const OFFLINE_THRESHOLD = 2;

/**
 * How long a successful probe is trusted by `confirmOnline()` before it pays
 * for a fresh one. Keeps rapid-fire actions (push then immediately pull) from
 * probing twice while still re-checking anything older than a few seconds.
 */
const FRESH_MS = 5_000;

// ─── Singleton state ──────────────────────────────────────
const isOnline = ref(true);
const lastCheckedAt = ref<number | null>(null);
const checking = ref(false);

// ─── Internal probe bookkeeping (module-private) ──────────
/** Consecutive unreachable probes since the last success. */
let _consecutiveFailures = 0;
/** Reachability of the most recent completed probe (null = none yet). */
let _lastProbeReachable: boolean | null = null;
/** Last repo path we probed — reused by event handlers and `confirmOnline`. */
let _lastRepoPath: string | null = null;

// ─── Internal: stable log handle ──────────────────────────
// `useLogs()` itself is module-scoped, so calling it once here is fine and
// keeps the import surface inside this file.
const { pushLog } = useLogs();

/**
 * Run one connectivity probe for the active repo.
 *
 * Safe to call concurrently — overlapping calls short-circuit so only one
 * probe is in flight at a time. When there's no repo or no remote we leave
 * `isOnline` alone (defaults to `true`) because there's nothing meaningful
 * to test: we don't want to surface "Offline" just because the user
 * happens to be on the welcome screen.
 */
/**
 * Apply a probe result to the *display* flag with hysteresis. A success flips
 * online immediately and resets the failure streak; a failure only flips
 * offline once `OFFLINE_THRESHOLD` consecutive failures have piled up.
 */
function applyProbeResult(reachable: boolean): void {
  _lastProbeReachable = reachable;
  if (reachable) {
    _consecutiveFailures = 0;
    if (!isOnline.value) {
      isOnline.value = true;
      pushLog("info", "Connectivity restored");
    }
  } else {
    _consecutiveFailures++;
    if (_consecutiveFailures >= OFFLINE_THRESHOLD && isOnline.value) {
      isOnline.value = false;
      pushLog("warn", "Connectivity lost — remote unreachable");
    }
  }
}

/**
 * Resolve the repo's `origin` URL and probe its reachability.
 *
 * Returns the raw reachability (`true`/`false`) or `null` when there's
 * nothing meaningful to test (no remote configured). Updates the display
 * flag via `applyProbeResult` as a side effect. Throws only on an unexpected
 * IPC failure — callers decide whether that should block.
 */
async function runProbe(path: string): Promise<boolean | null> {
  let url = "";
  try {
    const info = await gitRemoteInfo(path);
    url = (info?.url ?? "").trim();
  } catch {
    // The repo has no `origin` configured — nothing to test. Stay optimistic.
    return null;
  }
  if (!url) return null;

  const reachable = await checkRemoteReachable(url, PROBE_TIMEOUT_MS);
  lastCheckedAt.value = Date.now();
  applyProbeResult(reachable);
  return reachable;
}

/**
 * Run one background connectivity probe for the active repo (called by the
 * poller every ~30 s). Concurrency-guarded so only one probe is in flight.
 * When there's no repo or no remote we leave `isOnline` alone (defaults to
 * `true`) — we don't want to surface "Offline" on the welcome screen.
 */
export async function probeConnectivity(
  activeRepoPath: string | null,
): Promise<void> {
  if (checking.value) return;
  if (!activeRepoPath) {
    // No active repo → nothing to probe. Stay optimistic.
    return;
  }
  _lastRepoPath = activeRepoPath;
  checking.value = true;
  try {
    await runProbe(activeRepoPath);
  } catch (err) {
    // Probe itself failed (DNS resolver crashed, IPC threw, etc.).
    // Log once but don't flip state — we lack evidence either way.
    const message = err instanceof Error ? err.message : String(err);
    pushLog("warn", `Connectivity probe failed: ${message}`);
  } finally {
    checking.value = false;
  }
}

/**
 * Authoritative, on-demand connectivity check for the moment a user triggers
 * a network action (push / pull / fetch / PR ops…). This is what the network
 * guard calls — NOT the smoothed `isOnline` display flag — so a stale or
 * spurious "offline" reading can never block an action that would actually
 * succeed, and a genuine outage blocks it before git hangs on a dead socket.
 *
 *   - A recent *successful* probe (< `FRESH_MS`) is trusted → instant `true`,
 *     so back-to-back actions don't each pay for a probe.
 *   - Otherwise we run a FRESH probe and return its raw result. A failure
 *     blocks (no 5-min IPC hang); a success allows and clears the flag.
 *   - With no repo path to probe, or when the probe can't run (no remote,
 *     IPC error), we stay optimistic and return `true` — never block on
 *     missing evidence.
 */
export async function confirmOnline(): Promise<boolean> {
  if (
    _lastProbeReachable === true &&
    lastCheckedAt.value !== null &&
    Date.now() - lastCheckedAt.value < FRESH_MS
  ) {
    return true;
  }
  if (!_lastRepoPath) return true;
  let result: boolean | null;
  try {
    result = await runProbe(_lastRepoPath);
  } catch {
    return true; // can't verify → don't block
  }
  return result === null ? true : result;
}

/**
 * Test-only: reset module-private probe bookkeeping so each unit test starts
 * from a clean slate (the rest of the singleton — `isOnline`, `lastCheckedAt`
 * — is plain refs the tests reset directly).
 */
export function _resetConnectivityState(): void {
  _consecutiveFailures = 0;
  _lastProbeReachable = null;
  _lastRepoPath = null;
}

// ─── Browser online/offline event wiring ──────────────────
// Module-level wiring so the listeners survive component unmounts. Adding
// them on first import keeps the singleton autonomous — consumers don't
// have to remember to call a setup function.
let _wired = false;
function ensureBrowserListenersOnce() {
  if (_wired || typeof window === "undefined") return;
  _wired = true;
  window.addEventListener("online", () => {
    // The OS says the link came back. Optimistically flip to online so the
    // user can act immediately, then confirm with a real probe of the last
    // known repo (the next poller tick would too, but this is faster).
    isOnline.value = true;
    _consecutiveFailures = 0;
    if (_lastRepoPath) void probeConnectivity(_lastRepoPath);
  });
  window.addEventListener("offline", () => {
    // CRITICAL: do NOT trust this event to flip us offline. On macOS the
    // WKWebView fires spurious `offline` events and reports
    // `navigator.onLine === false` while the network is perfectly fine —
    // the exact false-positive that used to block push/pull. Treat the
    // event only as a hint to run a real probe; `applyProbeResult` decides
    // (with hysteresis) whether we're actually offline.
    if (_lastRepoPath) void probeConnectivity(_lastRepoPath);
  });
}

// ─── Public composable ────────────────────────────────────
export function useConnectivity(): {
  isOnline: Ref<boolean>;
  lastCheckedAt: Ref<number | null>;
  checking: Ref<boolean>;
  probeConnectivity: typeof probeConnectivity;
} {
  // We wire the browser listeners on the first `useConnectivity()` call
  // that runs inside a component (so the import side-effects stay minimal
  // for unit tests that import this module).
  if (typeof window !== "undefined") {
    // Wire immediately — useNetworkStatus did this in onMounted, but
    // module-scoped singletons should be ready before mount so consumers
    // can read the ref synchronously during setup.
    ensureBrowserListenersOnce();
  }
  // Lifecycle hooks are optional here: the listeners are module-scoped
  // and never need to be torn down per-component. We still register an
  // onMounted / onUnmounted pair so accidental misuse outside setup() is
  // a noisy error rather than a silent no-op.
  try {
    onMounted(() => {
      ensureBrowserListenersOnce();
    });
    onUnmounted(() => {
      // Intentional no-op: the singleton outlives any individual
      // component. Listeners are released only on full app teardown,
      // which is when the window itself goes away.
    });
  } catch {
    // Called outside a component (e.g. from a plain script or a test) —
    // onMounted throws in that case. Safe to ignore.
  }

  return {
    isOnline,
    lastCheckedAt,
    checking,
    probeConnectivity,
  };
}

// Module-level re-exports for places that need the ref without going
// through `useConnectivity()` (e.g. the network guard helper).
export { isOnline, lastCheckedAt, checking };
