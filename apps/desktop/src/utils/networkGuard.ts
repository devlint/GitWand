/**
 * networkGuard — short-circuit network operations when the app is offline.
 *
 * Why a helper instead of inlining `if (!isOnline.value)` at every call site:
 *
 *  - The check has to happen at the TS layer, BEFORE we hit `tauriInvoke()`
 *    or `devFetch()`. Once the IPC call is in flight, network commands can
 *    hang on `git push` for the full 5-min IPC timeout — exactly the
 *    "spinner infini" failure mode F1 was filed to remove.
 *  - We want a single place that logs the skip and returns a uniform
 *    `false` so the caller can `if (!requireOnline(...)) return;` and
 *    short-circuit symmetrically across every wrapped op.
 *  - The user-visible signal is the Logs tab badge (P6) — the suppressed
 *    action shows up as a `WARN` entry that lights the badge in the status
 *    bar. We deliberately do not pop a modal/toast: per spec, offline mode
 *    must NOT spam dialogs, just gate the affected buttons.
 *
 * Usage:
 *
 *   if (!requireOnline("push")) return;
 *   const result = await gitPush(folderPath.value, publish);
 *
 * The `operationLabel` is the human-readable verb (push / pull / fetch /
 * clone / PR list …) — it's interpolated into the log entry so the user
 * can tell which action was suppressed.
 */

import { confirmOnline } from "../composables/useConnectivity";
import { useLogs } from "../composables/useLogs";

const { pushLog } = useLogs();

/**
 * Guard a network operation against the offline state.
 *
 * Async, because it asks `confirmOnline()` for an AUTHORITATIVE answer rather
 * than reading the smoothed `isOnline` display flag: a fresh probe runs at
 * action time (unless a successful one is seconds old), so a spurious/stale
 * "offline" reading — the macOS WKWebView false positive — can never block an
 * action that would actually succeed, and a real outage blocks before git
 * hangs on a dead socket.
 *
 * Returns `true` when the operation may proceed. Returns `false` only when a
 * fresh probe confirms we're offline — and appends a `WARN` entry to the
 * in-app log so the suppressed action shows up in Settings → Logs (status-bar
 * badge lights up).
 *
 * The caller short-circuits immediately on `false`:
 *
 *     if (!(await requireOnline("push"))) return;
 *     // proceed with the network call
 */
export async function requireOnline(operationLabel: string): Promise<boolean> {
  if (await confirmOnline()) return true;
  pushLog("warn", `Operation '${operationLabel}' skipped — offline`);
  return false;
}
