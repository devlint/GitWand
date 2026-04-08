import { ref, computed, watch } from "vue";
import {
  getGitStatus,
  getGitDiff,
  getGitLog,
  gitStage,
  gitUnstage,
  gitCommit,
  gitPush,
  gitPull,
  gitDiscard,
  getGitShow,
  getGitBranches,
  gitCreateBranch,
  gitSwitchBranch,
  gitDeleteBranch,
  type GitStatus,
  type GitDiff,
  type GitLogEntry,
  type FileChange,
  type GitPushPullResult,
  type GitBranch,
} from "../utils/backend";

export type ViewMode = "changes" | "merge" | "history" | "branches";

export interface RepoFileEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  section: "staged" | "unstaged" | "untracked" | "conflicted";
}

/**
 * Main composable for the Git repository view.
 * Manages repo status, file changes, diff, log, staging, committing, push/pull.
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

  // Commit editor state
  const commitMessage = ref("");
  const isCommitting = ref(false);
  const isPushing = ref(false);
  const isPulling = ref(false);
  const lastCommitHash = ref<string | null>(null);

  // Branch state
  const branches = ref<GitBranch[]>([]);
  const branchesLoading = ref(false);

  // Commit diff state (for history view)
  const selectedCommitHash = ref<string | null>(null);
  const commitDiffs = ref<GitDiff[]>([]);

  /** Whether a repo is loaded. */
  const hasRepo = computed(() => !!folderPath.value && !!status.value);

  /** Branch display text. */
  const branchDisplay = computed(() => {
    if (!status.value) return "";
    const s = status.value;
    let text = s.branch;
    if (s.ahead > 0 || s.behind > 0) {
      const parts: string[] = [];
      if (s.ahead > 0) parts.push(`\u2191${s.ahead}`);
      if (s.behind > 0) parts.push(`\u2193${s.behind}`);
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

  /** How many commits ahead / behind the remote tracking branch. */
  const aheadCount = computed(() => status.value?.ahead ?? 0);
  const behindCount = computed(() => status.value?.behind ?? 0);

  /** Can we commit? (staged files + non-empty message) */
  const canCommit = computed(() => {
    return repoStats.value.staged > 0 && commitMessage.value.trim().length > 0 && !isCommitting.value;
  });

  /** Can we push? */
  const canPush = computed(() => {
    if (!status.value) return false;
    return status.value.ahead > 0 && !isPushing.value;
  });

  /** Can we pull? */
  const canPull = computed(() => {
    if (!status.value) return false;
    return status.value.behind > 0 && !isPulling.value;
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

  /**
   * Select a commit and load its diffs.
   */
  async function selectCommit(hash: string) {
    if (!folderPath.value) return;
    selectedCommitHash.value = hash;
    try {
      commitDiffs.value = await getGitShow(folderPath.value, hash);
    } catch (err: any) {
      commitDiffs.value = [];
      error.value = `git show: ${err.message}`;
    }
  }

  // ─── Staging operations ─────────────────────────────────

  /**
   * Stage specific files.
   */
  async function stageFiles(paths: string[]) {
    if (!folderPath.value) return;
    try {
      await gitStage(folderPath.value, paths);
      await refresh();
    } catch (err: any) {
      error.value = `git add: ${err.message}`;
    }
  }

  /**
   * Stage all unstaged + untracked files.
   */
  async function stageAll() {
    if (!folderPath.value || !status.value) return;
    const paths = [
      ...status.value.unstaged.map((f) => f.path),
      ...status.value.untracked,
    ];
    if (paths.length === 0) return;
    await stageFiles(paths);
  }

  /**
   * Unstage specific files.
   */
  async function unstageFiles(paths: string[]) {
    if (!folderPath.value) return;
    try {
      await gitUnstage(folderPath.value, paths);
      await refresh();
    } catch (err: any) {
      error.value = `git reset: ${err.message}`;
    }
  }

  /**
   * Unstage all staged files.
   */
  async function unstageAll() {
    if (!folderPath.value || !status.value) return;
    const paths = status.value.staged.map((f) => f.path);
    if (paths.length === 0) return;
    await unstageFiles(paths);
  }

  // ─── Commit ─────────────────────────────────────────────

  /**
   * Commit staged changes with the current message.
   */
  async function commit() {
    if (!folderPath.value || !canCommit.value) return;
    isCommitting.value = true;
    try {
      const hash = await gitCommit(folderPath.value, commitMessage.value.trim());
      lastCommitHash.value = hash;
      commitMessage.value = "";
      await refresh();
    } catch (err: any) {
      error.value = `commit: ${err.message}`;
    } finally {
      isCommitting.value = false;
    }
  }

  // ─── Push / Pull ────────────────────────────────────────

  async function push() {
    if (!folderPath.value) return;
    isPushing.value = true;
    try {
      const result = await gitPush(folderPath.value);
      if (!result.success) {
        error.value = `push: ${result.message}`;
      }
      await refresh();
    } catch (err: any) {
      error.value = `push: ${err.message}`;
    } finally {
      isPushing.value = false;
    }
  }

  async function pull() {
    if (!folderPath.value) return;
    isPulling.value = true;
    try {
      const result = await gitPull(folderPath.value);
      if (!result.success) {
        error.value = `pull: ${result.message}`;
      }
      await refresh();
    } catch (err: any) {
      error.value = `pull: ${err.message}`;
    } finally {
      isPulling.value = false;
    }
  }

  // ─── Discard ────────────────────────────────────────────

  // ─── Branches ────────────────────────────────────────────

  async function loadBranches() {
    if (!folderPath.value) return;
    branchesLoading.value = true;
    try {
      branches.value = await getGitBranches(folderPath.value);
    } catch (err: any) {
      error.value = `branches: ${err.message}`;
    } finally {
      branchesLoading.value = false;
    }
  }

  async function createBranch(name: string) {
    if (!folderPath.value) return;
    try {
      await gitCreateBranch(folderPath.value, name, true);
      await refresh();
      await loadBranches();
    } catch (err: any) {
      error.value = `create branch: ${err.message}`;
    }
  }

  async function switchBranch(name: string) {
    if (!folderPath.value) return;
    try {
      await gitSwitchBranch(folderPath.value, name);
      await refresh();
      await loadBranches();
    } catch (err: any) {
      error.value = `switch branch: ${err.message}`;
    }
  }

  async function deleteBranch(name: string) {
    if (!folderPath.value) return;
    try {
      await gitDeleteBranch(folderPath.value, name, false);
      await loadBranches();
    } catch (err: any) {
      error.value = `delete branch: ${err.message}`;
    }
  }

  // ─── Discard ────────────────────────────────────────────

  async function discardFiles(paths: string[]) {
    if (!folderPath.value) return;
    try {
      await gitDiscard(folderPath.value, paths);
      await refresh();
    } catch (err: any) {
      error.value = `discard: ${err.message}`;
    }
  }

  return {
    // State
    folderPath,
    status,
    selectedFilePath,
    selectedFileStaged,
    diff,
    log,
    loading,
    error,
    viewMode,
    commitMessage,
    isCommitting,
    isPushing,
    isPulling,
    lastCommitHash,
    branches,
    branchesLoading,
    selectedCommitHash,
    commitDiffs,
    // Computed
    hasRepo,
    branchDisplay,
    isClean,
    allFiles,
    repoStats,
    canCommit,
    canPush,
    canPull,
    aheadCount,
    behindCount,
    // Actions
    openRepo,
    refresh,
    selectFile,
    loadLog,
    stageFiles,
    stageAll,
    unstageFiles,
    unstageAll,
    commit,
    push,
    pull,
    discardFiles,
    selectCommit,
    loadBranches,
    createBranch,
    switchBranch,
    deleteBranch,
  };
}
