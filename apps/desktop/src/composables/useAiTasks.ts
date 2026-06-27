import { ref } from "vue";

/**
 * useAiTasks — registry of GitWand AI-task scratch worktrees.
 *
 * An "AI task" is a `gitwand-scratch-*` worktree spun up by `onNewAiTask`
 * (App.vue) to run an agent (Claude Code) in isolation from the active
 * checkout. Each one is opened as its own repo tab.
 *
 * This composable records which open tabs are AI tasks so the UI can:
 *   1. badge them in the project bar (RepoTabStrip), and
 *   2. delete / merge-back the underlying worktree when the tab is closed
 *      (instead of leaving the worktree lingering on disk).
 *
 * The map is persisted to localStorage keyed by the scratch worktree's
 * absolute path, so the marker + close behaviour survive an app restart
 * (repo tabs are themselves restored by path in useRepoTabs).
 *
 * Thin store: reactive state + persistence, no backend calls. The actual
 * worktree removal goes through backend.ts (`scratchWorktreeDiscard` /
 * `scratchWorktreeMergeBack`) from App.vue.
 */

const STORAGE_KEY = "gitwand-ai-tasks";

export interface AiTask {
  /** Absolute path of the scratch worktree (stable identity / map key). */
  path: string;
  /**
   * Absolute path of the repo the task was launched from. Needed as the
   * `cwd` argument when discarding / merging back — the scratch operations
   * must run from the origin checkout, not from inside the scratch itself.
   */
  originCwd: string;
  /** Scratch branch name (`gitwand-scratch-<timestamp>`). */
  branch: string;
  /** Creation time (epoch unix seconds). */
  createdAt: number;
}

/** Naming convention every GitWand scratch worktree branch/dir follows. */
const SCRATCH_PREFIX = "gitwand-scratch-";

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || path;
}

function load(): Record<string, AiTask> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, AiTask> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        val && typeof val === "object" &&
        typeof (val as AiTask).path === "string" &&
        typeof (val as AiTask).originCwd === "string"
      ) {
        out[key] = val as AiTask;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ─── Singleton state ────────────────────────────────────────
const tasks = ref<Record<string, AiTask>>(load());

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.value));
  } catch {
    /* best-effort */
  }
}

export function useAiTasks() {
  /** Record a freshly created scratch worktree as an AI task. */
  function register(task: AiTask) {
    const key = normalize(task.path);
    tasks.value = { ...tasks.value, [key]: { ...task, path: key } };
    persist();
  }

  /** Forget an AI task (after its worktree is removed). */
  function unregister(path: string) {
    const key = normalize(path);
    if (!(key in tasks.value)) return;
    const next = { ...tasks.value };
    delete next[key];
    tasks.value = next;
    persist();
  }

  /** Lookup the recorded task for a path, if any. */
  function get(path: string): AiTask | undefined {
    return tasks.value[normalize(path)];
  }

  /**
   * Whether a path is an AI task. Primary signal is the registry; the
   * basename convention is a fallback so an orphaned scratch worktree (e.g.
   * registry cleared but tab restored) is still recognised as AI-managed.
   */
  function isAiTask(path: string): boolean {
    const key = normalize(path);
    if (key in tasks.value) return true;
    const base = key.split("/").pop() ?? "";
    return base.startsWith(SCRATCH_PREFIX);
  }

  return { tasks, register, unregister, get, isAiTask };
}
