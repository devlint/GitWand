/**
 * useTrackedIgnored - tracked files that now match an ignore rule.
 *
 * A file committed before its `.gitignore` rule was written stays tracked, so
 * the rule does nothing for it. This composable asks the backend which tracked
 * paths match an ignore rule (`git ls-files -ci --exclude-standard`), keeps the
 * answer for the active repo, remembers a dismissal per repo until the set of
 * paths changes, and untracks a selection (`git rm --cached`: files stay on
 * disk, the removal is staged).
 *
 * Cost: the check is NOT part of the status poll. App.vue runs it when a repo
 * is opened, when the Live Repo watcher reports an ignore file (`.gitignore`
 * at any level, `.git/info/exclude`) or a HEAD move, and after a manual
 * refresh. Calls are debounced and one-at-a-time per repo.
 */
import { computed, ref } from "vue";
import { gitTrackedIgnored, gitUntrackPaths, type TrackedIgnored } from "../utils/backend";

const STORAGE_PREFIX = "gitwand:trackedIgnoredDismissed:";
const CHECK_DEBOUNCE_MS = 400;

/** True for a repo-relative path that holds ignore rules. */
export function isIgnoreFilePath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return p === ".gitignore" || p.endsWith("/.gitignore") || p === ".git/info/exclude";
}

/** Minimal shape of a Live Repo watcher event this module reads. */
export interface IgnoreChangeEvent {
  kinds: string[];
  paths: string[];
  truncated: boolean;
}

/**
 * Whether a watcher event can have changed the answer. An ignore file edited,
 * or a HEAD move (checkout, pull, reset can bring another `.gitignore` or
 * another set of tracked files), or a batch too large to inspect path by path.
 */
export function shouldRecheckTrackedIgnored(ev: IgnoreChangeEvent): boolean {
  if (ev.kinds.includes("head")) return true;
  if (ev.truncated) return true;
  return ev.paths.some(isIgnoreFilePath);
}

/**
 * Stable signature of a result, so a dismissal holds until the set changes.
 * FNV-1a over the sorted paths plus the total: short enough for localStorage
 * whatever the size of the list.
 */
export function signatureOf(info: TrackedIgnored): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  feed(String(info.total));
  for (const p of [...info.paths].sort()) feed(p);
  return `${info.total}:${h.toString(16)}`;
}

function readDismissed(cwd: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + cwd);
  } catch {
    return null;
  }
}

function writeDismissed(cwd: string, signature: string) {
  try {
    localStorage.setItem(STORAGE_PREFIX + cwd, signature);
  } catch {
    /* private mode / quota: the notice just comes back next session */
  }
}

function clearDismissed(cwd: string) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + cwd);
  } catch {
    /* see writeDismissed */
  }
}

// Module-level state: one active repo at a time, shared by App.vue (triggers)
// and the notice component (rendering), as with the other composable stores.
const activeCwd = ref<string | null>(null);
const info = ref<TrackedIgnored | null>(null);
const dismissedSignature = ref<string | null>(null);
const error = ref<string | null>(null);
// Repos with a `git rm --cached` in flight. Per repo, so switching away while
// one runs neither blocks the next repo's button nor leaks the spinner there.
const untrackingIn = ref<ReadonlySet<string>>(new Set());
const untracking = computed(() => !!activeCwd.value && untrackingIn.value.has(activeCwd.value));

function setUntracking(cwd: string, on: boolean) {
  const next = new Set(untrackingIn.value);
  if (on) next.add(cwd);
  else next.delete(cwd);
  untrackingIn.value = next;
}

let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const signature = computed(() => (info.value ? signatureOf(info.value) : null));

/** Notice shown: something to report, and not dismissed for this exact set. */
const visible = computed(
  () => !!info.value && info.value.total > 0 && signature.value !== dismissedSignature.value,
);

/**
 * Run the check for `cwd` now (null clears the state). `cwd` becomes the
 * active repo: callers pass the repo the user is looking at. A response that
 * lands after a newer check (same repo or another) is dropped.
 */
async function check(cwd: string | null): Promise<void> {
  const gen = ++generation;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (cwd !== activeCwd.value) {
    activeCwd.value = cwd;
    info.value = null;
    error.value = null;
    dismissedSignature.value = cwd ? readDismissed(cwd) : null;
  }
  if (!cwd) return;
  try {
    const result = await gitTrackedIgnored(cwd);
    if (gen !== generation) return; // a newer check or another repo won
    info.value = result;
    if (result.total === 0) {
      // Nothing left: forget the dismissal so a later recurrence is shown.
      dismissedSignature.value = null;
      clearDismissed(cwd);
    }
  } catch (err) {
    if (gen !== generation) return;
    // Best-effort feature: a failing `ls-files` must never surface as an error
    // banner. Keep the previous answer's absence and log for diagnosis.
    info.value = null;
    console.warn("[gitwand] tracked-but-ignored check failed", err);
  }
}

/** Debounced `check` for the active repo (watcher bursts, manual refreshes). */
function scheduleCheck(): void {
  const cwd = activeCwd.value;
  if (!cwd) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void check(cwd);
  }, CHECK_DEBOUNCE_MS);
}

function dismiss(): void {
  const cwd = activeCwd.value;
  if (!cwd || !signature.value) return;
  dismissedSignature.value = signature.value;
  writeDismissed(cwd, signature.value);
}

/**
 * Untrack `paths` in the active repo, then re-check. Resolves true on
 * success; on failure `error` carries the message and nothing is changed.
 *
 * The repo is captured before the await. If the user has switched repo by the
 * time git answers, the result belongs to a repo no longer shown: no re-check
 * (`check(cwd)` would make the old repo active again and show its notice in
 * the new one) and no error banner. The old repo is checked afresh when it is
 * reopened.
 */
async function untrack(paths: string[]): Promise<boolean> {
  const cwd = activeCwd.value;
  if (!cwd || paths.length === 0 || untrackingIn.value.has(cwd)) return false;
  setUntracking(cwd, true);
  error.value = null;
  try {
    await gitUntrackPaths(cwd, paths);
    if (activeCwd.value === cwd) await check(cwd);
    return true;
  } catch (err: any) {
    if (activeCwd.value === cwd) error.value = err?.message ?? String(err);
    return false;
  } finally {
    setUntracking(cwd, false);
  }
}

/** Test seam: forget everything, as if the app had just started. */
function reset(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  activeCwd.value = null;
  info.value = null;
  dismissedSignature.value = null;
  untrackingIn.value = new Set();
  error.value = null;
}

export function useTrackedIgnored() {
  return {
    info,
    visible,
    untracking,
    error,
    check,
    scheduleCheck,
    dismiss,
    untrack,
    reset,
  };
}
