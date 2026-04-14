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
  gitFetch,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitDiscard,
  gitAmendCommit,
  gitStagePatch,
  gitUnstagePatch,
  getGitShow,
  getGitBranches,
  gitCreateBranch,
  gitSwitchBranch,
  gitDeleteBranch,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitStashList,
  gitStashApply,
  gitStashDrop,
  type GitStatus,
  type GitDiff,
  type GitLogEntry,
  type FileChange,
  type GitPushPullResult,
  type GitBranch,
  type StashEntry,
  gitAddToGitignore,
} from "../utils/backend";

export type ViewMode = "dashboard" | "changes" | "history" | "graph" | "prs";

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
  const successMessage = ref<string | null>(null);
  const viewMode = ref<ViewMode>("dashboard");

  // Commit editor state
  const COMMIT_SIGNATURE = "\u{1FA84} Commit via GitWand";
  const commitSummary = ref("");

  function getCommitSignatureDefault(): string {
    try {
      const raw = localStorage.getItem("gitwand-settings");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.commitSignature === false) return "";
      }
    } catch { /* ignore */ }
    return COMMIT_SIGNATURE;
  }

  const commitDescription = ref(getCommitSignatureDefault());
  const isCommitting = ref(false);
  const isPushing = ref(false);
  const isPulling = ref(false);
  const lastCommitHash = ref<string | null>(null);

  // Branch state
  const branches = ref<GitBranch[]>([]);
  const branchesLoading = ref(false);
  const isSwitchingBranch = ref(false);
  const isMerging = ref(false);

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
  /** Is the currently selected file in conflicted state? */
  const isSelectedFileConflicted = computed(() => {
    if (!selectedFilePath.value || !status.value) return false;
    return status.value.conflicted.includes(selectedFilePath.value);
  });

  /** Are there unresolved merge conflicts? */
  const hasConflicts = computed(() => {
    return (status.value?.conflicted.length ?? 0) > 0;
  });

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

  /** Can we commit? (staged files + non-empty summary) */
  const canCommit = computed(() => {
    return repoStats.value.staged > 0 && commitSummary.value.trim().length > 0 && !isCommitting.value;
  });

  /** Can we push? */
  const canPush = computed(() => {
    if (!status.value) return false;
    return status.value.ahead > 0 && !isPushing.value;
  });

  /** Can we pull? Enabled whenever a remote is configured. */
  const canPull = computed(() => {
    if (!status.value) return false;
    return !!status.value.remote && !isPulling.value;
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
   * Fetch from remote (background, non-blocking).
   * Updates tracking refs so ahead/behind counts become accurate.
   */
  let fetchInterval: ReturnType<typeof setInterval> | null = null;
  const isFetching = ref(false);

  async function fetchRemote() {
    // Skip fetch during merge operations to avoid git lock conflicts
    if (!folderPath.value || isFetching.value || isMerging.value || hasConflicts.value) return;
    isFetching.value = true;
    try {
      const result = await gitFetch(folderPath.value);
      console.log("[GitWand] fetch result:", result);
      // Always refresh status after fetch attempt to get updated ahead/behind
      await loadStatus(folderPath.value);
      console.log("[GitWand] status after fetch:", {
        ahead: status.value?.ahead,
        behind: status.value?.behind,
        remote: status.value?.remote,
      });
    } catch (err) {
      console.warn("[GitWand] fetch failed:", err);
    } finally {
      isFetching.value = false;
    }
  }

  function startAutoFetch() {
    stopAutoFetch();
    // Initial fetch after a short delay, then every 30s
    fetchInterval = setInterval(fetchRemote, 30_000);
  }

  function stopAutoFetch() {
    if (fetchInterval) {
      clearInterval(fetchInterval);
      fetchInterval = null;
    }
  }

  /**
   * Open a repository folder.
   */
  async function openRepo(path: string) {
    loading.value = true;
    error.value = null;
    folderPath.value = path;

    // Reset previous repo state
    selectedCommitHash.value = null;
    commitDiffs.value = [];
    log.value = [];
    selectedFilePath.value = null;
    diff.value = null;

    try {
      await loadStatus(path);
    } catch (err: any) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }

    // Background fetch then refresh status — awaited so UI updates before user interacts
    fetchRemote();
    startAutoFetch();
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
      // If a commit was selected but its diffs were lost, reload them
      if (selectedCommitHash.value && commitDiffs.value.length === 0) {
        commitDiffs.value = await getGitShow(folderPath.value, selectedCommitHash.value);
      }
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

  /**
   * Stage a partial diff patch (hunk/line level).
   */
  async function stagePatch(patch: string) {
    if (!folderPath.value) return;
    try {
      await gitStagePatch(folderPath.value, patch);
      await refresh();
    } catch (err: any) {
      error.value = `git apply: ${err.message}`;
    }
  }

  /**
   * Unstage a partial diff patch (hunk/line level).
   */
  async function unstagePatch(patch: string) {
    if (!folderPath.value) return;
    try {
      await gitUnstagePatch(folderPath.value, patch);
      await refresh();
    } catch (err: any) {
      error.value = `git apply --reverse: ${err.message}`;
    }
  }

  // ─── Commit ─────────────────────────────────────────────

  /**
   * Commit staged changes with the current message.
   */
  async function commit() {
    if (!folderPath.value || !canCommit.value) return;
    isCommitting.value = true;
    try {
      const desc = commitDescription.value.trim();
      const fullMessage = desc
        ? `${commitSummary.value.trim()}\n\n${desc}`
        : commitSummary.value.trim();
      const hash = await gitCommit(folderPath.value, fullMessage);
      lastCommitHash.value = hash;
      commitSummary.value = "";
      commitDescription.value = getCommitSignatureDefault();
      await refresh();
      await loadLog();
    } catch (err: any) {
      error.value = `commit: ${err.message}`;
    } finally {
      isCommitting.value = false;
    }
  }

  /**
   * Amend the HEAD commit message (only works on unpushed HEAD).
   */
  async function amendCommit(summary: string, description: string) {
    if (!folderPath.value) return;
    const fullMessage = description.trim()
      ? `${summary.trim()}\n\n${description.trim()}`
      : summary.trim();
    try {
      await gitAmendCommit(folderPath.value, fullMessage);
      await refresh();
      await loadLog();
    } catch (err: any) {
      error.value = `amend: ${err.message}`;
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
      } else {
        successMessage.value = "push-done";
      }
      await refresh();
      await loadLog();
    } catch (err: any) {
      error.value = `push: ${err.message}`;
    } finally {
      isPushing.value = false;
    }
  }

  async function pull(rebase: boolean = false) {
    if (!folderPath.value) return;
    isPulling.value = true;
    try {
      // Fetch all branches first (updates origin/master, etc.)
      await gitFetch(folderPath.value);
      const result = await gitPull(folderPath.value, rebase);
      if (!result.success) {
        error.value = `pull: ${result.message}`;
      } else {
        // Show success feedback
        const msg = (result.message || "").trim();
        if (msg.includes("Already up to date") || msg.includes("Already up-to-date")) {
          successMessage.value = "already-up-to-date";
        } else {
          successMessage.value = "sync-done";
        }
      }
      await refresh();
      await loadLog();
    } catch (err: any) {
      error.value = `pull: ${err.message}`;
    } finally {
      isPulling.value = false;
    }
  }

  // ─── Merge ──────────────────────────────────────────────

  async function mergeBranch(branchName: string) {
    if (!folderPath.value || !branchName) return;
    stopAutoFetch();
    isMerging.value = true;
    try {
      const result = await gitMerge(folderPath.value, branchName);
      await refresh();

      // Detect conflicts from both the server response and the git status
      const hasConflictedFiles = status.value && status.value.conflicted.length > 0;
      const serverSaysConflicts = result.conflicts === true;

      if (hasConflictedFiles) {
        // Conflicts found in status → switch to changes view and select first conflict
        viewMode.value = "changes";
        await selectFile(status.value!.conflicted[0], false);
      } else if (serverSaysConflicts) {
        // Server detected conflicts but status didn't catch them yet — reload status and retry
        if (folderPath.value) {
          await loadStatus(folderPath.value);
        }
        if (status.value && status.value.conflicted.length > 0) {
          viewMode.value = "changes";
          await selectFile(status.value.conflicted[0], false);
        } else {
          // Fallback: still show changes view so user can see the state
          viewMode.value = "changes";
          error.value = `merge: ${result.message || "unknown error"}`;
        }
      } else if (!result.success) {
        error.value = `merge: ${result.message || "unknown error"}`;
      } else {
        successMessage.value = "merge-done";
      }

      if (viewMode.value === "history") {
        await loadLog();
      }
    } catch (err: any) {
      error.value = `merge: ${err?.message || String(err) || "unknown error"}`;
    } finally {
      isMerging.value = false;
      // Restart auto-fetch only if no conflicts remain (conflicts = merge still in progress)
      if (!hasConflicts.value) startAutoFetch();
    }
  }

  /** Abort an in-progress merge. */
  async function abortMerge() {
    if (!folderPath.value) return;
    try {
      await gitMergeAbort(folderPath.value);
      successMessage.value = "merge-aborted";
      await refresh();
    } catch (err: any) {
      error.value = `abort merge: ${err?.message || String(err)}`;
    } finally {
      startAutoFetch();
    }
  }

  /** Continue a merge after all conflicts have been resolved. */
  async function mergeContinue() {
    if (!folderPath.value) return;
    isMerging.value = true;
    try {
      const result = await gitMergeContinue(folderPath.value);
      await refresh();
      if (result.success) {
        successMessage.value = "merge-done";
      } else {
        error.value = `merge --continue: ${result.message || "unknown error"}`;
      }
      if (viewMode.value === "history") {
        await loadLog();
      }
    } catch (err: any) {
      error.value = `merge --continue: ${err?.message || String(err)}`;
    } finally {
      isMerging.value = false;
      startAutoFetch();
    }
  }

  // ─── Cherry-pick (Phase 8.2) ─────────────────────────────

  const isCherryPicking = ref(false);

  async function cherryPick(hashes: string[]) {
    if (!folderPath.value || hashes.length === 0) return;
    isCherryPicking.value = true;
    try {
      const result = await gitCherryPick(folderPath.value, hashes);
      if (result.conflicts) {
        error.value = "Cherry-pick has conflicts. Resolve them then continue.";
      } else if (!result.success) {
        error.value = `cherry-pick: ${result.message}`;
      } else {
        successMessage.value = "cherry-pick-done";
      }
      await refresh();
      await loadLog();
    } catch (err: any) {
      error.value = `cherry-pick: ${err.message}`;
    } finally {
      isCherryPicking.value = false;
    }
  }

  async function cherryPickAbort() {
    if (!folderPath.value) return;
    try {
      await gitCherryPickAbort(folderPath.value);
      successMessage.value = "cherry-pick-aborted";
      await refresh();
    } catch (err: any) {
      error.value = `cherry-pick abort: ${err.message}`;
    }
  }

  async function cherryPickContinue() {
    if (!folderPath.value) return;
    isCherryPicking.value = true;
    try {
      const result = await gitCherryPickContinue(folderPath.value);
      if (result.success) {
        successMessage.value = "cherry-pick-done";
      } else {
        error.value = `cherry-pick continue: ${result.message}`;
      }
      await refresh();
      await loadLog();
    } catch (err: any) {
      error.value = `cherry-pick continue: ${err.message}`;
    } finally {
      isCherryPicking.value = false;
    }
  }

  // ─── Stash Manager (Phase 8.2) ─────────────────────────

  const stashes = ref<StashEntry[]>([]);
  const stashesLoading = ref(false);

  async function loadStashes() {
    if (!folderPath.value) return;
    stashesLoading.value = true;
    try {
      stashes.value = await gitStashList(folderPath.value);
    } catch (err: any) {
      error.value = `stash list: ${err.message}`;
    } finally {
      stashesLoading.value = false;
    }
  }

  async function applyStash(index: number) {
    if (!folderPath.value) return;
    try {
      await gitStashApply(folderPath.value, index);
      await refresh();
    } catch (err: any) {
      error.value = `stash apply: ${err.message}`;
    }
  }

  async function dropStash(index: number) {
    if (!folderPath.value) return;
    try {
      await gitStashDrop(folderPath.value, index);
      await loadStashes();
    } catch (err: any) {
      error.value = `stash drop: ${err.message}`;
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
    isSwitchingBranch.value = true;
    try {
      await gitSwitchBranch(folderPath.value, name);
      await refresh();
      await loadBranches();
    } catch (err: any) {
      error.value = `switch branch: ${err.message}`;
    } finally {
      isSwitchingBranch.value = false;
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

  async function discardFiles(paths: string[], untracked = false) {
    if (!folderPath.value) return;
    try {
      await gitDiscard(folderPath.value, paths, untracked);
      await refresh();
    } catch (err: any) {
      error.value = `discard: ${err.message}`;
    }
  }

  async function addToGitignore(path: string) {
    if (!folderPath.value) return;
    try {
      await gitAddToGitignore(folderPath.value, path);
      await refresh();
    } catch (err: any) {
      error.value = `gitignore: ${err.message}`;
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
    successMessage,
    viewMode,
    isCommitting,
    isPushing,
    isPulling,
    lastCommitHash,
    branches,
    branchesLoading,
    isSwitchingBranch,
    isMerging,
    selectedCommitHash,
    commitDiffs,
    // Computed
    hasRepo,
    branchDisplay,
    isClean,
    hasConflicts,
    isSelectedFileConflicted,
    allFiles,
    repoStats,
    commitSummary,
    commitDescription,
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
    stagePatch,
    unstagePatch,
    commit,
    amendCommit,
    push,
    pull,
    mergeBranch,
    mergeContinue,
    abortMerge,
    discardFiles,
    addToGitignore,
    selectCommit,
    loadBranches,
    createBranch,
    switchBranch,
    deleteBranch,
    // Cherry-pick (Phase 8.2)
    isCherryPicking,
    cherryPick,
    cherryPickAbort,
    cherryPickContinue,
    // Stash Manager (Phase 8.2)
    stashes,
    stashesLoading,
    loadStashes,
    applyStash,
    dropStash,
  };
}
