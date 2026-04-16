/**
 * useInteractiveRebase — composable for interactive rebase in GitWand.
 *
 * Workflow:
 *   1. User picks a base (branch or commit).
 *   2. `listCommits(cwd, base)` fetches the rebase-eligible commits.
 *   3. User reorders / changes actions in the UI.
 *   4. `startRebase(cwd, base, entries)` calls a dedicated backend
 *      endpoint that writes a temp todo file and runs
 *      `GIT_SEQUENCE_EDITOR="cp <tmp> " git rebase -i <base>`.
 *   5. If conflicts arise the rebase pauses — the UI shows continue / abort / skip.
 *   6. `detectRebaseState(cwd)` checks for an in-progress rebase.
 */

import { ref, computed } from "vue";
import { gitExec, isTauri } from "../utils/backend";

const DEV_SERVER = "http://localhost:24842";

// ─── Types ──────────────────────────────────────────────────

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "edit" | "drop";

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
      // Quick check: does REBASE_HEAD exist?
      const rh = await gitExec(cwd, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
      const hasRebaseHead = rh.exitCode === 0;

      if (!hasRebaseHead) {
        // Also check rebase-merge dir (rebase may be paused before first apply)
        const dirCheck = await gitExec(cwd, [
          "rev-parse", "--git-path", "rebase-merge/interactive",
        ]);
        // The file only exists during interactive rebase
        const interactivePath = dirCheck.stdout.trim();
        // We can't `cat` via gitExec, but we can check if rebase-merge/msgnum exists
        const msgnumCheck = await gitExec(cwd, [
          "rev-parse", "--git-path", "rebase-merge/msgnum",
        ]);
        // If these files exist in .git, ls-files won't work.
        // Simpler: run `git status` and parse for "interactive rebase in progress"
        const st = await gitExec(cwd, ["status"]);
        if (!st.stdout.includes("interactive rebase in progress") && !st.stdout.includes("rebase interactif en cours")) {
          progress.value = null;
          return null;
        }
      }

      // Parse step info from git status long output
      const statusResult = await gitExec(cwd, ["status"]);
      const statusText = statusResult.stdout;

      let step = 0;
      let total = 0;
      let headName = "";
      let hasConflict = false;

      // English: "interactive rebase in progress; onto abc1234"
      // Also: "You are currently rebasing branch 'foo' on 'abc1234'."
      const branchMatch = statusText.match(/rebasing branch '([^']+)'/);
      if (branchMatch) headName = branchMatch[1];

      // "Last commands done (2 commands done):"
      // or "Last command done (1 command done):"
      const doneMatch = statusText.match(/\((\d+) commands? done\)/);
      if (doneMatch) step = parseInt(doneMatch[1], 10);

      // "Next commands to do (3 remaining commands):"
      // or "(1 remaining command)"
      const remainMatch = statusText.match(/\((\d+) remaining commands?\)/);
      if (remainMatch) total = step + parseInt(remainMatch[1], 10);
      else total = step; // all done, last step

      // Conflict detection
      const conflictCheck = await gitExec(cwd, ["status", "--porcelain"]);
      hasConflict = conflictCheck.stdout.split("\n").some((l) => l.startsWith("UU ") || l.startsWith("AA ") || l.startsWith("UD ") || l.startsWith("DU "));

      const currentHash = hasRebaseHead ? rh.stdout.trim().slice(0, 7) : "";

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
  ): Promise<{ success: boolean; error?: string; conflict?: boolean }> {
    isRunning.value = true;
    error.value = null;

    const todoLines = entries.map((e) => `${e.action} ${e.hash} ${e.message}`);

    try {
      // Both Tauri and dev-server use the same endpoint pattern.
      // For Tauri we'll add a Rust command later; for dev mode we
      // need a dedicated endpoint because GIT_SEQUENCE_EDITOR requires
      // env-var control that gitExec doesn't support.
      const res = await fetch(
        isTauri() ? "/api/git-interactive-rebase" : `${DEV_SERVER}/api/git-interactive-rebase`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, base, todoLines }),
        },
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.conflict) {
        await detectRebaseState(cwd);
        return { success: true, conflict: true };
      }
      progress.value = null;
      return { success: true };
    } catch (err: any) {
      error.value = err.message;
      return { success: false, error: err.message };
    } finally {
      isRunning.value = false;
    }
  }

  // ── Continue / Abort / Skip ───────────────────────────────

  async function rebaseContinue(cwd: string): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
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
          return { success: true, conflict: true };
        }
        throw new Error(result.stderr || "rebase --continue failed");
      }
      progress.value = null;
      return { success: true };
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
    } catch (err: any) {
      error.value = err.message;
    } finally {
      isRunning.value = false;
    }
  }

  async function rebaseSkip(cwd: string): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
    isRunning.value = true;
    error.value = null;
    try {
      const result = await gitExec(cwd, ["rebase", "--skip"]);
      if (result.exitCode !== 0) {
        if (result.stderr.includes("CONFLICT") || result.stderr.includes("could not apply")) {
          await detectRebaseState(cwd);
          return { success: true, conflict: true };
        }
        throw new Error(result.stderr || "rebase --skip failed");
      }
      progress.value = null;
      return { success: true };
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
