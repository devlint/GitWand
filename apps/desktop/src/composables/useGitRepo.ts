import { ref, computed, watch } from "vue";
import {
  getGitStatus,
  getGitDiff,
  getGitLog,
  type GitStatus,
  type GitDiff,
  type GitLogEntry,
  type FileChange,
} from "../utils/backend";

export type ViewMode = "changes" | "merge" | "history";

export interface RepoFileEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  section: "staged" | "unstaged" | "untracked" | "conflicted";
}

/**
 * Main composable for the Git repository view.
 * Manages repo status, file changes, diff, and log.
 */
export function useGitRepo() {
  const folderPath = ref<string | null>(null);
  const status = ref<GitStatus | null>(null);
  const selectedFilePath = ref<string | null>(null);
  const selectedFileStaged = ref(false);
  const diff = ref<GitDiff | null>(null);
  const log = ref<GitLogEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const viewMode = ref<ViewMode>("changes");

  /** Whether a repo is loaded. */
  const hasRepo = computed(() => !!folderPath.value && !!status.value);

  /** Branch display text. */
  const branchDisplay = computed(() => {
    if (!status.value) return "";
    const s = status.value;
    let text = s.branch;
    if (s.ahead > 0 || s.behind > 0) {
      const parts: string[] = [];
      if (s.ahead > 0) parts.push(`↑${s.ahead}`);
      if (s.behind > 0) parts.push(`↓${s.behind}`);
      text += ` ${parts.join(" ")}`;
    }
    return text;
  });

  /** Is the repo clean (no changes at all)? */
  const isClean = computed(() => {
    if (!status.value) return true;
    const s = status.value;
    return (
      s.staged.length === 0 &&
      s.unstaged.length === 0 &&
      s.untracked.length === 0 &&
      s.conflicted.length === 0
    );
  });

  /** Flattened list of all changed files for the sidebar. */
  const allFiles = computed<RepoFileEntry[]>(() => {
    if (!status.value) return [];
    const s = status.value;
    const result: RepoFileEntry[] = [];

    for (const f of s.conflicted) {
      result.push({ path: f, status: "modified", section: "conflicted" });
    }
    for (const f of s.staged) {
      result.push({ path: f.path, status: f.status, section: "staged" });
    }
    for (const f of s.unstaged) {
      result.push({ path: f.path, status: f.status, section: "unstaged" });
    }
    for (const f of s.untracked) {
      result.push({ path: f, status: "added", section: "untracked" });
    }
    return result;
  });

  /** Quick stats for the header. */
  const repoStats = computed(() => {
    if (!status.value) return { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    const s = status.value;
    return {
      staged: s.staged.length,
      unstaged: s.unstaged.length,
      untracked: s.untracked.length,
      conflicted: s.conflicted.length,
    };
  });

  /**
   * Load the status of a repo.
   */
  async function loadStatus(cwd: string) {
    try {
      status.value = await getGitStatus(cwd);
    } catch (err: any) {
      error.value = `git status: ${err.message}`;
    }
  }

  /**
   * Open a repository folder.
   */
  async function openRepo(path: string) {
    loading.value = true;
    error.value = null;
    folderPath.value = path;

    try {
      await loadStatus(path);
    } catch (err: any) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Refresh status (e.g. after a commit or stage operation).
   */
  async function refresh() {
    if (!folderPath.value) return;
    await loadStatus(folderPath.value);
    // Also refresh diff if a file is selected
    if (selectedFilePath.value) {
      await loadDiff(selectedFilePath.value, selectedFileStaged.value);
    }
  }

  /**
   * Select a file and load its diff.
   */
  async function selectFile(path: string, staged: boolean = false) {
    selectedFilePath.value = path;
    selectedFileStaged.value = staged;
    await loadDiff(path, staged);
  }

  /**
   * Load diff for a file.
   */
  async function loadDiff(path: string, staged: boolean) {
    if (!folderPath.value) return;
    try {
      diff.value = await getGitDiff(folderPath.value, path, staged);
    } catch (err: any) {
      // No diff (new file, etc.) — show empty
      diff.value = { path, hunks: [] };
    }
  }

  /**
   * Load the commit log.
   */
  async function loadLog(count?: number) {
    if (!folderPath.value) return;
    try {
      log.value = await getGitLog(folderPath.value, count);
    } catch (err: any) {
      error.value = `git log: ${err.message}`;
    }
  }

  return {
    folderPath,
    status,
    selectedFilePath,
    selectedFileStaged,
    diff,
    log,
    loading,
    error,
    viewMode,
    hasRepo,
    branchDisplay,
    isClean,
    allFiles,
    repoStats,
    openRepo,
    refresh,
    selectFile,
    loadLog,
  };
}
