import { ref, computed } from "vue";
import { gitExec } from "../utils/backend";

/**
 * Undo stack — parses `git reflog` and provides one-click undo for
 * common Git operations (commit, merge, cherry-pick, rebase, amend, stash, reset).
 *
 * Each reflog entry is categorized by type so the UI can show an
 * appropriate icon and label, and the undo logic can pick the right
 * strategy (soft reset for commits, hard reset for merges, etc.).
 */

// ─── Types ──────────────────────────────────────────────

export type UndoOpType =
  | "commit"
  | "amend"
  | "merge"
  | "cherry-pick"
  | "rebase"
  | "pull"
  | "reset"
  | "checkout"
  | "stash"
  | "other";

export interface UndoEntry {
  /** Reflog index (0 = most recent). */
  index: number;
  /** Abbreviated commit hash AFTER the operation. */
  hash: string;
  /** Hash BEFORE the operation (the one to reset to for undo). */
  prevHash: string;
  /** Detected operation type. */
  type: UndoOpType;
  /** Human-readable summary from reflog. */
  summary: string;
  /** Raw reflog subject line. */
  raw: string;
  /** Relative date string from git. */
  date: string;
}

// ─── Reflog parsing ─────────────────────────────────────

/**
 * Detect the operation type from a reflog subject line.
 */
function classifyReflog(subject: string): UndoOpType {
  const s = subject.toLowerCase();
  if (s.startsWith("commit (amend)")) return "amend";
  if (s.startsWith("commit (merge)") || s.startsWith("merge")) return "merge";
  if (s.startsWith("commit")) return "commit";
  if (s.includes("cherry-pick")) return "cherry-pick";
  if (s.startsWith("rebase")) return "rebase";
  if (s.startsWith("pull")) return "pull";
  if (s.startsWith("reset")) return "reset";
  if (s.startsWith("checkout") || s.startsWith("switch")) return "checkout";
  if (s.includes("stash")) return "stash";
  return "other";
}

/**
 * Summarise a reflog line into a short user-facing label.
 */
function summarize(subject: string, type: UndoOpType): string {
  // Strip the reflog prefix ("commit: ", "merge: ", etc.)
  const colonIdx = subject.indexOf(": ");
  const tail = colonIdx >= 0 ? subject.slice(colonIdx + 2).trim() : subject;

  switch (type) {
    case "commit":
    case "amend":
      return tail || "commit";
    case "merge":
      return tail ? `merge: ${tail}` : "merge";
    case "cherry-pick":
      return tail ? `cherry-pick: ${tail}` : "cherry-pick";
    case "rebase":
      return tail || "rebase";
    case "pull":
      return tail || "pull";
    case "reset":
      return tail || "reset";
    case "checkout":
      return tail || "checkout";
    case "stash":
      return tail || "stash";
    default:
      return tail || subject;
  }
}

/** Types of operations that can be undone. */
const UNDOABLE: Set<UndoOpType> = new Set([
  "commit",
  "amend",
  "merge",
  "cherry-pick",
  "rebase",
  "pull",
]);

// ─── Composable ─────────────────────────────────────────

const entries = ref<UndoEntry[]>([]);
const isLoading = ref(false);
const lastError = ref<string | null>(null);

/** Max reflog entries to fetch. */
const MAX_ENTRIES = 50;

export function useUndoStack() {
  /**
   * Refresh the undo stack by parsing `git reflog`.
   */
  async function refresh(cwd: string): Promise<void> {
    if (!cwd) return;
    isLoading.value = true;
    lastError.value = null;

    try {
      // Format: hash<TAB>prevHash<TAB>subject<TAB>relativeDate
      const result = await gitExec(cwd, [
        "reflog",
        "--format=%h\t%gd\t%gs\t%cr",
        `-n${MAX_ENTRIES}`,
      ]);

      if (result.exitCode !== 0) {
        throw new Error((result.stderr ?? "").trim() || "git reflog failed");
      }

      const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
      const parsed: UndoEntry[] = [];

      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split("\t");
        if (parts.length < 4) continue;
        const [hash, , subject, date] = parts;
        const type = classifyReflog(subject);
        // prevHash = the hash of the NEXT line (older state)
        // For the last entry, prevHash stays empty (can't undo further)
        const prevHash = i + 1 < lines.length ? lines[i + 1].split("\t")[0] : "";

        parsed.push({
          index: i,
          hash,
          prevHash,
          type,
          summary: summarize(subject, type),
          raw: subject,
          date,
        });
      }

      entries.value = parsed;
    } catch (err: unknown) {
      lastError.value = err instanceof Error ? err.message : String(err);
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Can this entry be undone?
   */
  function canUndo(entry: UndoEntry): boolean {
    return UNDOABLE.has(entry.type) && !!entry.prevHash;
  }

  /**
   * Undo a specific operation by resetting to the state before it.
   *
   * Strategy by type:
   * - commit / amend → `git reset --soft <prev>` (keep changes staged)
   * - merge / cherry-pick / rebase / pull → `git reset --hard <prev>`
   */
  async function undo(cwd: string, entry: UndoEntry): Promise<void> {
    if (!canUndo(entry)) return;
    isLoading.value = true;
    lastError.value = null;

    try {
      const soft = entry.type === "commit" || entry.type === "amend";
      const mode = soft ? "--soft" : "--hard";
      const result = await gitExec(cwd, ["reset", mode, entry.prevHash]);

      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr ?? "").trim() || `git reset ${mode} failed`,
        );
      }

      // Refresh the stack after undo.
      await refresh(cwd);
    } catch (err: unknown) {
      lastError.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  /** The most recent undoable entry, if any. */
  const lastUndoable = computed(() =>
    entries.value.find((e) => canUndo(e)) ?? null,
  );

  return {
    entries,
    isLoading,
    lastError,
    lastUndoable,
    refresh,
    canUndo,
    undo,
  };
}
