/**
 * useInteractiveRebase — Vue composable for interactive rebase in GitWand.
 *
 * Workflow:
 *   1. User picks a base (branch or commit) in the RebaseEditor UI.
 *   2. `listCommits(cwd, base)` fetches the rebase-eligible commits.
 *   3. User reorders / changes actions in the UI.
 *   4. `startRebase(cwd, base, entries)` calls a dedicated backend
 *      endpoint that writes a temp todo file and runs
 *      `GIT_SEQUENCE_EDITOR="cp <tmp> " git rebase -i <base>`.
 *   5. If conflicts arise the rebase pauses — the UI shows continue / abort / skip.
 *   6. `detectRebaseState(cwd)` checks for an in-progress rebase.
 */

import { ref, computed } from "vue";
import { gitExec, gitInteractiveRebase } from "../utils/backend";

// ─── Types ──────────────────────────────────────────────────

/**
 * Rebase actions.
 *
 * Note: `split` is a GitWand-only synthetic action. Git itself has no native
 * "split" verb — we serialize it as `edit` in the todo file and record the
 * commit's full SHA in the module-level `pendingSplits` set. When the rebase
 * halts at such a commit, the UI offers a "Split this commit…" action that
 * opens the `SplitCommitModal` via `useSplitCommit()` — same workflow as a
 * HEAD split from the log context menu.
 */
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "edit" | "drop" | "split";

export interface RebaseTodoEntry {
  action: RebaseAction;
  /** Short hash. */
  hash: string;
  /** Full hash. */
  fullHash: string;
  /** First-line commit message. */
  message: string;
  /** Author name. */
  author: string;
  /** Relative date. */
  date: string;
  /** New message (used when action === "reword"). */
  newMessage?: string;
}

export interface RebaseProgress {
  inProgress: boolean;
  /** 1-based current step. */
  step: number;
  total: number;
  /** Short hash of REBASE_HEAD (the commit being applied). */
  currentHash: string;
  /** True when stopped on a conflict. */
  hasConflict: boolean;
  /** Branch name being rebased. */
  headName: string;
}

// ─── Module-level state for the `split` action ─────────────
//
// `split` is a GitWand-only synthetic action — the rebase todo file serializes
// it as `edit`, and we keep track of which commits were originally marked for
// splitting in this module-level map so that the UI can, when the rebase halts
// at such a commit, offer the "Split this commit…" action that drives
// `useSplitCommit()`.
//
// The map is keyed by full SHA and stores the original entry (for its message
// and body). It's intentionally module-level so that multiple callers of
// `useInteractiveRebase()` (e.g. the rebase editor + the top-level app shell
// watching for halts) can observe the same state.

interface PendingSplit {
  fullHash: string;
  shortHash: string;
  message: string;
}

const pendingSplits = ref<Map<string, PendingSplit>>(new Map());

/**
 * Returns the pending-split entry matching the rebase's current halted commit,
 * or null if the halt is not on a split-marked commit. Matches on prefix since
 * `progress.currentHash` is truncated to 7 chars.
 */
export function getPendingSplitAtHead(
  progress: RebaseProgress | null,
): PendingSplit | null {
  if (!progress || !progress.inProgress) return null;
  return getPendingSplitForHash(progress.currentHash ?? null);
}

/**
 * v3.11 — the same lookup, addressed by a bare hash.
 *
 * `RebaseEditor` has a `RebaseProgress` to hand; the app shell watching for
 * halts only has `RepoOperationState.operationHead`, which the Rust backend
 * reads from `.git/REBASE_HEAD`. Verified against real git: at both an `edit`
 * stop and a conflict stop that is the *original* pre-rebase commit, which is
 * exactly what `pendingSplits` is keyed by, so the two callers can share this.
 *
 * `getPendingSplitAtHead` delegates here so the prefix-matching rule cannot
 * drift between them.
 */
export function getPendingSplitForHash(hash: string | null): PendingSplit | null {
  if (!hash) return null;
  for (const entry of pendingSplits.value.values()) {
    if (entry.fullHash.startsWith(hash) || entry.shortHash === hash) {
      return entry;
    }
  }
  return null;
}

/** Clear the pending-split set (e.g. after abort or completion). */
export function clearPendingSplits(): void {
  pendingSplits.value = new Map();
}

/**
 * Remove a specific pending split (e.g. after the user has completed the split
 * for that commit). The rebase-continue step happens separately.
 */
export function resolvePendingSplit(fullHash: string): void {
  const next = new Map(pendingSplits.value);
  next.delete(fullHash);
  pendingSplits.value = next;
}

// ─── Composable ─────────────────────────────────────────────

export function useInteractiveRebase() {
  const isLoading = ref(false);
  const isRunning = ref(false);
  const error = ref<string | null>(null);
  const todoEntries = ref<RebaseTodoEntry[]>([]);
  const progress = ref<RebaseProgress | null>(null);

  // ── List commits ──────────────────────────────────────────

  async function listCommits(cwd: string, base: string): Promise<RebaseTodoEntry[]> {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await gitExec(cwd, [
        "log", "--reverse", "--format=%h\t%H\t%s\t%an\t%cr",
        `${base}..HEAD`,
      ]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "git log failed");

      const entries: RebaseTodoEntry[] = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, fullHash, message, author, date] = line.split("\t");
          return { action: "pick" as RebaseAction, hash, fullHash, message, author, date };
        });

      todoEntries.value = entries;
      return entries;
    } catch (err: any) {
      error.value = err.message;
      return [];
    } finally {
      isLoading.value = false;
    }
  }

  // ── Detect in-progress rebase ─────────────────────────────

  async function detectRebaseState(cwd: string): Promise<RebaseProgress | null> {
    try {
      // Most reliable check: `git status` long-form mentions
      // "interactive rebase in progress" (English) or
      // "rebase interactif en cours" (French) when a rebase is active.
      // We force English output with LC_ALL=C via a harmless -c flag.
      const st = await gitExec(cwd, [
        "-c", "advice.statusHints=true",
        "status",
      ]);
      const statusText = st.stdout;

      // Match specifically the rebase-in-progress message, NOT the branch name
      const isRebasing =
        /interactive rebase in progress/.test(statusText) ||
        /rebase interactif en cours/.test(statusText) ||
        /You are currently rebasing/.test(statusText) ||
        /Vous êtes en train de rebaser/.test(statusText);

      if (!isRebasing) {
        progress.value = null;
        return null;
      }

      // Parse step/total from status output
      let step = 0;
      let total = 0;
      let headName = "";

      const branchMatch = statusText.match(/rebasing branch '([^']+)'/);
      if (branchMatch) headName = branchMatch[1];

      const doneMatch = statusText.match(/\((\d+) commands? done\)/);
      if (doneMatch) step = parseInt(doneMatch[1], 10);

      const remainMatch = statusText.match(/\((\d+) remaining commands?\)/);
      if (remainMatch) total = step + parseInt(remainMatch[1], 10);
      else total = step;

      // Get REBASE_HEAD for current hash
      const rh = await gitExec(cwd, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
      const currentHash = rh.exitCode === 0 ? rh.stdout.trim().slice(0, 7) : "";

      // Conflict detection via porcelain status
      const conflictCheck = await gitExec(cwd, ["status", "--porcelain"]);
      const hasConflict = conflictCheck.stdout.split("\n").some(
        (l) => l.startsWith("UU ") || l.startsWith("AA ") || l.startsWith("UD ") || l.startsWith("DU "),
      );

      const state: RebaseProgress = {
        inProgress: true,
        step,
        total,
        currentHash,
        hasConflict,
        headName,
      };
      progress.value = state;
      return state;
    } catch {
      progress.value = null;
      return null;
    }
  }

  // ── Start interactive rebase ──────────────────────────────

  /**
   * Start an interactive rebase. Uses a dedicated endpoint that writes
   * a temp todo-file and injects it via GIT_SEQUENCE_EDITOR.
   */
  async function startRebase(
    cwd: string,
    base: string,
    entries: RebaseTodoEntry[],
  ): Promise<{ success: boolean; error?: string; conflict?: boolean; inProgress?: boolean }> {
    isRunning.value = true;
    error.value = null;

    // `split` is a GitWand-only action — git's sequencer understands only the
    // six built-in verbs, so we serialize `split` as `edit` and remember which
    // commits were originally marked for splitting. When the rebase halts on
    // an edit, the UI can cross-reference this set to offer the split modal.
    const nextPending = new Map<string, PendingSplit>();
    const todoLines = entries.map((e) => {
      if (e.action === "split") {
        nextPending.set(e.fullHash, {
          fullHash: e.fullHash,
          shortHash: e.hash,
          message: e.message,
        });
        return `edit ${e.hash} ${e.message}`;
      }
      return `${e.action} ${e.hash} ${e.message}`;
    });
    pendingSplits.value = nextPending;

    try {
      // `gitInteractiveRebase` writes a temp todo file and injects it via
      // GIT_SEQUENCE_EDITOR. In Tauri it routes through the `git_interactive_rebase`
      // Rust command; in web-dev mode it hits the dev-server endpoint — both
      // because plain `gitExec` can't control the sequence-editor env var.
      const data = await gitInteractiveRebase(cwd, base, todoLines);
      if (data.conflict) {
        await detectRebaseState(cwd);
        return { success: true, conflict: true, inProgress: true };
      }
      // Even when the backend reports success, the rebase may still be in
      // progress — `edit` (and our synthetic `split`) halts exit with code 0
      // on the git side, so the backend can't distinguish them from a fully
      // completed rebase. Check rebase state here: if it's still in progress,
      // surface that to the caller so the UI stays on the progress banner
      // and the pending-split lookup has something to match. `conflict` is
      // reserved for merge conflicts; the broader "rebase not finished" signal
      // is `inProgress`.
      const state = await detectRebaseState(cwd);
      if (state?.inProgress) {
        return { success: true, conflict: state.hasConflict, inProgress: true };
      }
      progress.value = null;
      clearPendingSplits();
      return { success: true, inProgress: false };
    } catch (err: any) {
      error.value = err.message;
      return { success: false, error: err.message };
    } finally {
      isRunning.value = false;
    }
  }

  // ── Continue / Abort / Skip ───────────────────────────────

  async function rebaseContinue(cwd: string): Promise<{ success: boolean; conflict?: boolean; error?: string; inProgress?: boolean }> {
    isRunning.value = true;
    error.value = null;
    try {
      // Need to set sequence.editor=true to skip editor on reword commits
      const result = await gitExec(cwd, [
        "-c", "sequence.editor=true",
        "rebase", "--continue",
      ]);
      if (result.exitCode !== 0) {
        if (result.stderr.includes("CONFLICT") || result.stderr.includes("could not apply")) {
          await detectRebaseState(cwd);
          return { success: true, conflict: true, inProgress: true };
        }
        throw new Error(result.stderr || "rebase --continue failed");
      }
      // Even on exit-0 the rebase may have hit another halt (next `edit`/`split`).
      // Probe state and surface the halt via `inProgress` — `conflict` remains
      // reserved for merge-conflict halts specifically.
      const state = await detectRebaseState(cwd);
      if (state?.inProgress) {
        return { success: true, conflict: state.hasConflict, inProgress: true };
      }
      progress.value = null;
      clearPendingSplits();
      return { success: true, inProgress: false };
    } catch (err: any) {
      error.value = err.message;
      return { success: false, error: err.message };
    } finally {
      isRunning.value = false;
    }
  }

  async function rebaseAbort(cwd: string): Promise<void> {
    isRunning.value = true;
    error.value = null;
    try {
      const result = await gitExec(cwd, ["rebase", "--abort"]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "rebase --abort failed");
      progress.value = null;
      todoEntries.value = [];
      clearPendingSplits();
    } catch (err: any) {
      error.value = err.message;
    } finally {
      isRunning.value = false;
    }
  }

  async function rebaseSkip(cwd: string): Promise<{ success: boolean; conflict?: boolean; error?: string; inProgress?: boolean }> {
    isRunning.value = true;
    error.value = null;
    try {
      const result = await gitExec(cwd, ["rebase", "--skip"]);
      if (result.exitCode !== 0) {
        if (result.stderr.includes("CONFLICT") || result.stderr.includes("could not apply")) {
          await detectRebaseState(cwd);
          return { success: true, conflict: true, inProgress: true };
        }
        throw new Error(result.stderr || "rebase --skip failed");
      }
      // Skip may land on another halt (edit/split on the next commit).
      const state = await detectRebaseState(cwd);
      if (state?.inProgress) {
        return { success: true, conflict: state.hasConflict, inProgress: true };
      }
      progress.value = null;
      clearPendingSplits();
      return { success: true, inProgress: false };
    } catch (err: any) {
      error.value = err.message;
      return { success: false, error: err.message };
    } finally {
      isRunning.value = false;
    }
  }

  // ── Todo list mutations (for the UI) ──────────────────────

  function moveEntry(fromIndex: number, toIndex: number) {
    const list = [...todoEntries.value];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    todoEntries.value = list;
  }

  function setAction(index: number, action: RebaseAction) {
    const list = [...todoEntries.value];
    list[index] = { ...list[index], action };
    todoEntries.value = list;
  }

  function setNewMessage(index: number, message: string) {
    const list = [...todoEntries.value];
    list[index] = { ...list[index], newMessage: message, action: "reword" };
    todoEntries.value = list;
  }

  function reset() {
    todoEntries.value = [];
    progress.value = null;
    error.value = null;
  }

  const hasChanges = computed(() =>
    todoEntries.value.some((e) => e.action !== "pick"),
  );

  return {
    isLoading,
    isRunning,
    error,
    todoEntries,
    progress,
    hasChanges,
    listCommits,
    detectRebaseState,
    startRebase,
    rebaseContinue,
    rebaseAbort,
    rebaseSkip,
    moveEntry,
    setAction,
    setNewMessage,
    reset,
  };
}
