import { ref, computed, watch } from "vue";
import {
  getGitStatus,
  getGitDiff,
  getGitLog,
  getGitRevCount,
  getGitUser,
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
  gitDeleteRemoteBranch,
  gitDeleteTag,
  gitDeleteRemoteTag,
  gitRenameBranch,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitStashList,
  gitStashApply,
  gitStashDrop,
  gitWorktreeList,
  type GitStatus,
  type GitDiff,
  type GitLogEntry,
  type GitUser,
  type FileChange,
  type GitPushPullResult,
  type GitBranch,
  type StashEntry,
  type WorktreeEntry,
  gitAddToGitignore,
} from "../utils/backend";
import { requireOnline } from "../utils/networkGuard";
import { t } from "./useI18n";
import { useWorkspaceScope } from "./useWorkspaceScope";

export type ViewMode = "dashboard" | "changes" | "history" | "graph" | "prs" | "launchpad";

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
  // Author filter: "all" → no filter, "mine" → only commits by the current git user
  const logAuthorFilter = ref<"all" | "mine">("all");
  const currentGitUser = ref<GitUser | null>(null);
  /** True when the last page returned a full page of results — more may exist. */
  const logHasMore = ref(false);
  /** Set to true while loadMoreLog() is fetching. */
  const logLoadingMore = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const successMessage = ref<string | null>(null);
  const viewMode = ref<ViewMode>("dashboard");
  const forcePushPreferred = ref(false);

  // ── Monorepo scope (v2.21.0) ────────────────────────────────────────────
  const { activeScope } = useWorkspaceScope();
  /** Total commits across all refs, ignoring scope. Drives the hidden badge. */
  const totalUnscopedCount = ref(0);
  /** Total commits across all refs touching the active scope sub-tree. */
  const scopedTotalCount = ref(0);

  /**
   * Number of commits hidden by the active scope.
   * Locked decision: unscopedTotal − scopedTotal (stable across pagination),
   * NOT scoped.length. Zero when no scope is active.
   */
  const hiddenCommitCount = computed(() =>
    activeScope.value ? Math.max(0, totalUnscopedCount.value - scopedTotalCount.value) : 0,
  );

  /** Refresh the unscoped + scoped rev counts for the hidden-commit badge. */
  async function loadRevCounts() {
    if (!folderPath.value) return;
    try {
      totalUnscopedCount.value = await getGitRevCount(folderPath.value, undefined, true);
      scopedTotalCount.value = activeScope.value
        ? await getGitRevCount(folderPath.value, undefined, true, activeScope.value)
        : totalUnscopedCount.value;
    } catch {
      // Non-fatal — the badge just won't update. Don't surface to the user.
    }
  }

  function forcePushKey(): string | null {
    const path = folderPath.value;
    const branch = status.value?.branch;
    if (!path || !branch) return null;
    return `gitwand:fpp:${path}:${branch}`;
  }

  // Persist forcePushPreferred to localStorage so it survives app reloads.
  watch(forcePushPreferred, (val) => {
    const key = forcePushKey();
    if (!key) return;
    if (val) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  });

  // Restore from localStorage when status (and thus branch) becomes known.
  watch(() => status.value?.branch, (branch) => {
    if (!branch) return;
    const key = forcePushKey();
    forcePushPreferred.value = key ? localStorage.getItem(key) === "1" : false;
  });

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

  // Worktree state
  const worktrees = ref<WorktreeEntry[]>([]);
  const worktreeBranches = computed(() => {
    const set = new Set<string>();
    for (const wt of worktrees.value) {
      if (wt.branch && !wt.is_main) set.add(wt.branch);
    }
    return set;
  });

  // Commit diff state (for history view)
  const selectedCommitHash = ref<string | null>(null);
  const commitDiffs = ref<GitDiff[]>([]);

  /**
   * Search-palette invalidation on active-repo change.
   *
   * `openRepo` / `closeRepo` already clear `branches` and `log`, but that
   * only covers code paths that go through those two functions. Any future
   * code path that mutates `folderPath` directly (or a hot-reload scenario
   * mid-session) would leave stale branches in the palette — the user
   * opens repo B and sees branches from repo A on Cmd/Ctrl+K (bug §B1).
   *
   * This watch is the single source of truth for "active repo changed →
   * forget the palette's source data". It fires for null↔path↔path
   * transitions. Not `immediate: true` — initial mount has nothing to
   * invalidate, and we don't want to clobber the very first hydration.
   */
  watch(folderPath, () => {
    branches.value = [];
    log.value = [];
  });

  /**
   * Monorepo scope changed → re-fetch the scoped log, status and rev counts.
   *
   * Shallow watch on the ref only — never `{ deep: true }` (perf rule: deep
   * tracking on reactive structures is exponential). `activeScope` is a plain
   * `Ref<string | null>`, so identity change is all we need to react to.
   */
  watch(activeScope, () => {
    if (!folderPath.value) return;
    void loadStatus(folderPath.value);
    void loadLog();
    void loadRevCounts();
  });

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

  /** Quick stats for the header and graph. */
  const repoStats = computed(() => {
    if (!status.value) return { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, added: 0, modified: 0, deleted: 0, renamed: 0 };
    const s = status.value;

    const fileStates = new Map<string, "added" | "modified" | "deleted" | "renamed">();

    for (const path of s.untracked) {
      fileStates.set(path, "added");
    }
    for (const path of s.conflicted) {
      fileStates.set(path, "modified");
    }
    for (const f of s.staged) {
      if (f.status === "added") fileStates.set(f.path, "added");
      else if (f.status === "deleted") fileStates.set(f.path, "deleted");
      else if (f.status === "renamed") fileStates.set(f.path, "renamed");
      else fileStates.set(f.path, "modified");
    }
    for (const f of s.unstaged) {
      const current = fileStates.get(f.path);
      if (f.status === "deleted") fileStates.set(f.path, "deleted");
      else if (f.status === "added") fileStates.set(f.path, "added");
      else if (!current) fileStates.set(f.path, "modified");
    }

    let added = 0, modified = 0, deleted = 0, renamed = 0;
    for (const state of fileStates.values()) {
      if (state === "added") added++;
      else if (state === "modified") modified++;
      else if (state === "deleted") deleted++;
      else if (state === "renamed") renamed++;
    }

    return {
      staged: s.staged.length,
      unstaged: s.unstaged.length,
      untracked: s.untracked.length,
      conflicted: s.conflicted.length,
      added,
      modified,
      deleted,
      renamed
    };
  });

  /** How many commits ahead / behind the remote tracking branch. */
  const aheadCount = computed(() => status.value?.ahead ?? 0);
  const behindCount = computed(() => status.value?.behind ?? 0);
  const mainCommitCount = computed(() => status.value?.mainCommitCount ?? 1);
  /** Push remote when it differs from upstream (fork / triangular workflow). */
  const pushRemote = computed(() => status.value?.pushRemote ?? null);
  /** Commits ahead of the push remote (fork setup only). */
  const aheadPushCount = computed(() => status.value?.aheadPush ?? 0);

  /** Can we commit? (staged files + non-empty summary) */
  const canCommit = computed(() => {
    return repoStats.value.staged > 0 && commitSummary.value.trim().length > 0 && !isCommitting.value;
  });

  /**
   * True when the current branch has no upstream configured (`@{u}`).
   * A push then must use `--set-upstream` to link it to the remote — whether
   * or not the branch already exists there. Drives the push command, NOT the
   * "Publish" UI (see `needsPublish`).
   */
  const needsUpstream = computed(() => {
    if (!status.value) return false;
    return !status.value.remote;
  });

  /**
   * True only when the branch has genuinely never been pushed — no upstream
   * AND no matching remote-tracking ref. This is what gates the "Publish"
   * banner/primary action. A branch that exists on the remote but lost its
   * tracking config (pushed without `-u`, `gh pr checkout`, fork checkout…)
   * is NOT "to publish": it shows normal ahead/behind and pushes with
   * `--set-upstream` under the hood.
   */
  const needsPublish = computed(() => {
    if (!status.value) return false;
    return !status.value.remote && !status.value.remoteBranchExists;
  });

  /**
   * Can we push?
   * - Yes when we have local commits ahead of the upstream.
   * - Yes when the branch has no upstream yet (first push publishes it).
   */
  const canPush = computed(() => {
    if (!status.value) return false;
    if (isPushing.value) return false;
    return status.value.ahead > 0 || needsPublish.value;
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
      // When a monorepo scope is active, scope the status to the sub-tree so
      // repoStats reflects only the scoped changes. None → libgit2 fast path.
      status.value = await getGitStatus(cwd, activeScope.value ?? undefined);
    } catch (err: any) {
      error.value = `git status: ${err.message}`;
    }
  }

  const isFetching = ref(false);

  /**
   * Fetch from remote (background, non-blocking).
   * Updates tracking refs so ahead/behind counts become accurate.
   * Used by both manual user action and the consolidated useRepoPoller.
   */
  async function fetchRemote() {
    // Skip fetch during merge operations to avoid git lock conflicts
    if (!folderPath.value || isFetching.value || isMerging.value || hasConflicts.value) return;
    // F1 — Mode hors-ligne: short-circuit before hitting the IPC so we
    // can never hang on the 5-min NETWORK timeout when the link is dead.
    if (!(await requireOnline("fetch"))) return;
    isFetching.value = true;
    try {
      await gitFetch(folderPath.value);
      // Always refresh status after fetch attempt to get updated ahead/behind
      await loadStatus(folderPath.value);
      // v2.14 — Refresh log so clicking "Up to date" or periodic fetch
      // updates the Git Tree / History view with new remote commits.
      await loadLog();
    } catch (err) {
      console.warn("[GitWand] fetch failed:", err);
    } finally {
      isFetching.value = false;
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
    branches.value = [];        // ← reset so the palette doesn't show stale branches from the previous repo
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
    loadWorktrees();
  }

  /**
   * Close the currently-open repository and reset all derived state so
   * the app returns to its empty/landing screen.
   *
   * This is called when the last repo tab is closed (see App.vue's
   * `activeTabId` watcher). Polling is stopped by useRepoPoller's
   * watch on repoFolderPath.
   */
  function closeRepo() {
    folderPath.value = null;
    status.value = null;
    selectedFilePath.value = null;
    selectedFileStaged.value = false;
    diff.value = null;
    log.value = [];
    selectedCommitHash.value = null;
    commitDiffs.value = [];
    branches.value = [];
    worktrees.value = [];
    error.value = null;
    successMessage.value = null;
    // Don't reset commit draft / viewMode — keeping them lets the user
    // reopen a repo without losing their in-progress commit message and
    // keeps the default view (dashboard) they expect.
  }

  /**
   * Refresh status (e.g. after a commit or stage operation).
   * v2.14 — Now also refreshes the commit log so the Git Tree and History
   * views stay in sync with the repository state.
   */
  async function refresh() {
    if (!folderPath.value) return;
    await Promise.all([
      loadStatus(folderPath.value),
      loadLog(),
    ]);
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
   * Load the commit log. Honors `logScope` (current branch vs all refs)
   * and `logAuthorFilter` (all authors vs current user only).
   */
  // Page size used for both initial load and subsequent pages.
  const LOG_PAGE = 100;

  async function loadLog(count?: number) {
    if (!folderPath.value) return;
    try {
      const authorEmail =
        logAuthorFilter.value === "mine" ? (currentGitUser.value?.email ?? "") : undefined;
      // When refreshing, reload at least as many commits as are currently visible
      // so polling doesn't silently collapse a paginated log back to page 1.
      const pageSize = count ?? Math.max(LOG_PAGE, log.value.length);
      const entries = await getGitLog(
        folderPath.value,
        pageSize,
        true, // all refs
        authorEmail,
        0,
        undefined, // branch
        activeScope.value ?? undefined, // pathspec (monorepo scope)
      );
      log.value = entries;
      // When the result is exactly one full page, assume more exist.
      logHasMore.value = entries.length >= pageSize;
      // Refresh the hidden-commit badge counts alongside the scoped log.
      await loadRevCounts();
      // If a commit was selected but its diffs were lost, reload them
      if (selectedCommitHash.value && commitDiffs.value.length === 0) {
        commitDiffs.value = await getGitShow(folderPath.value, selectedCommitHash.value);
      }
    } catch (err: any) {
      error.value = `git log: ${err.message}`;
    }
  }

  /**
   * Append the next page of commits to the log.
   * Called when the CommitLog scroll list emits `load-more`.
   */
  async function loadMoreLog() {
    if (!folderPath.value || !logHasMore.value || logLoadingMore.value) return;
    logLoadingMore.value = true;
    try {
      const authorEmail =
        logAuthorFilter.value === "mine" ? (currentGitUser.value?.email ?? "") : undefined;
      const offset = log.value.length;
      const next = await getGitLog(
        folderPath.value,
        LOG_PAGE,
        true, // all refs
        authorEmail,
        offset,
        undefined, // branch
        activeScope.value ?? undefined, // pathspec (monorepo scope)
      );
      if (next.length > 0) {
        log.value = [...log.value, ...next];
      }
      logHasMore.value = next.length >= LOG_PAGE;
    } catch (err: any) {
      error.value = `git log (page): ${err.message}`;
    } finally {
      logLoadingMore.value = false;
    }
  }

  /**
   * Toggle the author filter between "all" and "mine" and reload the log.
   * Fetches the current git user the first time "mine" is requested.
   */
  async function setLogAuthorFilter(filter: "all" | "mine") {
    if (logAuthorFilter.value === filter) return;
    if (filter === "mine" && !currentGitUser.value && folderPath.value) {
      currentGitUser.value = await getGitUser(folderPath.value);
    }
    logAuthorFilter.value = filter;
    await loadLog();
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
  async function commit(trailers = "") {
    if (!folderPath.value || !canCommit.value) return;
    isCommitting.value = true;
    try {
      const desc = commitDescription.value.trim();
      let fullMessage = desc
        ? `${commitSummary.value.trim()}\n\n${desc}`
        : commitSummary.value.trim();
      // Append trailers (Signed-off-by, Reviewed-by…) as a separate paragraph.
      // git trailer convention: one blank line before the trailer block.
      const trailerBlock = trailers.trim();
      if (trailerBlock) fullMessage += `\n\n${trailerBlock}`;
      const hash = await gitCommit(folderPath.value, fullMessage);
      lastCommitHash.value = hash;
      commitSummary.value = "";
      commitDescription.value = getCommitSignatureDefault();
      // Clear the diff viewer: the committed file is no longer in the
      // working tree, so keeping it selected would show a stale/empty diff.
      selectedFilePath.value = null;
      selectedFileStaged.value = false;
      diff.value = null;
      await refresh();
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
      // Reset the diff viewer — the amended file(s) are no longer in the
      // working tree, so the previously selected diff would be stale.
      selectedFilePath.value = null;
      selectedFileStaged.value = false;
      diff.value = null;
      await refresh();
    } catch (err: any) {
      error.value = `amend: ${err.message}`;
    }
  }

  // ─── Push / Pull ────────────────────────────────────────

  async function push(force: boolean = false) {
    if (!folderPath.value) return;
    if (!(await requireOnline("push"))) return;
    isPushing.value = true;
    try {
      // If the current branch has no upstream, push it with --set-upstream —
      // this covers both a genuine first publish and a branch that exists on
      // the remote but lost its tracking config.
      const publish = needsUpstream.value;
      const result = await gitPush(folderPath.value, publish, force);
      if (!result.success) {
        error.value = `push: ${result.message}`;
      } else {
        successMessage.value = "push-done";
        forcePushPreferred.value = false;
      }
      await refresh();
    } catch (err: any) {
      error.value = `push: ${err.message}`;
    } finally {
      isPushing.value = false;
    }
  }

  async function pull(rebase: boolean = false) {
    if (!folderPath.value) return;
    if (!(await requireOnline("pull"))) return;
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
        forcePushPreferred.value = false;
      }
      await refresh();
    } catch (err: any) {
      error.value = `pull: ${err.message}`;
    } finally {
      isPulling.value = false;
    }
  }

  // ─── Merge ──────────────────────────────────────────────

  async function mergeBranch(branchName: string) {
    if (!folderPath.value || !branchName) return;
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
    } catch (err: any) {
      error.value = `merge: ${err?.message || String(err) || "unknown error"}`;
    } finally {
      isMerging.value = false;
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
    } catch (err: any) {
      error.value = `merge --continue: ${err?.message || String(err)}`;
    } finally {
      isMerging.value = false;
    }
  }

  // ─── Cherry-pick (Phase 8.2) ─────────────────────────────

  const isCherryPicking = ref(false);

  async function cherryPick(hashes: string[]) {
    if (!folderPath.value || hashes.length === 0) return;
    isCherryPicking.value = true;
    try {
      const result = await gitCherryPick(folderPath.value, hashes);
      await refresh();

      const hasConflictedFiles = status.value && status.value.conflicted.length > 0;
      const serverSaysConflicts = result.conflicts === true;

      if (hasConflictedFiles) {
        // Stay in cherry-pick mode — isCherryPicking remains true until abort/continue
        viewMode.value = "changes";
        await selectFile(status.value!.conflicted[0], false);
        return; // early return: do NOT reset isCherryPicking
      } else if (serverSaysConflicts) {
        if (folderPath.value) await loadStatus(folderPath.value);
        if (status.value && status.value.conflicted.length > 0) {
          viewMode.value = "changes";
          await selectFile(status.value.conflicted[0], false);
          return; // early return: do NOT reset isCherryPicking
        } else {
          viewMode.value = "changes";
          error.value = `cherry-pick: ${result.message || "unknown error"}`;
        }
      } else if (!result.success) {
        error.value = `cherry-pick: ${result.message || "unknown error"}`;
      } else {
        successMessage.value = "cherry-pick-done";
      }
    } catch (err: any) {
      error.value = `cherry-pick: ${err.message}`;
    } finally {
      if (!hasConflicts.value) {
        isCherryPicking.value = false;
      }
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
    } finally {
      isCherryPicking.value = false;
    }
  }

  async function cherryPickContinue() {
    if (!folderPath.value) return;
    isCherryPicking.value = true;
    try {
      const result = await gitCherryPickContinue(folderPath.value);
      await refresh();
      if (result.success) {
        successMessage.value = "cherry-pick-done";
      } else if (result.conflicts) {
        // More conflicts remain — stay in cherry-pick mode
        if (status.value && status.value.conflicted.length > 0) {
          viewMode.value = "changes";
          await selectFile(status.value.conflicted[0], false);
        }
        return; // do NOT reset isCherryPicking
      } else {
        error.value = `cherry-pick continue: ${result.message}`;
      }
    } catch (err: any) {
      error.value = `cherry-pick continue: ${err.message}`;
    } finally {
      if (!hasConflicts.value) {
        isCherryPicking.value = false;
      }
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

  async function popStash(index: number) {
    if (!folderPath.value) return;
    try {
      await gitStashApply(folderPath.value, index);
      await gitStashDrop(folderPath.value, index);
      await refresh();
      await loadStashes();
      await loadLog();
    } catch (err: any) {
      error.value = `stash pop: ${err.message}`;
    }
  }

  async function dropStash(index: number) {
    if (!folderPath.value) return;
    try {
      await gitStashDrop(folderPath.value, index);
      await loadStashes();
      await loadLog();
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

  async function loadWorktrees() {
    if (!folderPath.value) return;
    try {
      worktrees.value = await gitWorktreeList(folderPath.value);
    } catch {
      // Ignore errors for worktrees
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
      forcePushPreferred.value = false;
      await refresh();
      await loadBranches();
      await loadWorktrees();
    } catch (err: any) {
      if (err.message?.includes("already used by worktree")) {
        error.value = t("branches.switchWorktree");
      } else {
        error.value = `switch branch: ${err.message}`;
      }
    } finally {
      isSwitchingBranch.value = false;
    }
  }

  async function deleteBranch(name: string) {
    if (!folderPath.value) return;
    try {
      await gitDeleteBranch(folderPath.value, name, false);
      await loadBranches();
      await loadLog();
    } catch (err: any) {
      error.value = `delete branch: ${err.message}`;
    }
  }

  async function deleteRemoteBranch(remote: string, name: string) {
    if (!folderPath.value) return;
    try {
      await gitDeleteRemoteBranch(folderPath.value, remote, name);
      await loadBranches();
      await loadLog();
    } catch (err: any) {
      error.value = `delete remote branch: ${err.message}`;
    }
  }

  async function deleteTag(name: string) {
    if (!folderPath.value) return;
    try {
      await gitDeleteTag(folderPath.value, name);
      await loadLog();
    } catch (err: any) {
      error.value = `delete tag: ${err.message}`;
    }
  }

  async function deleteRemoteTag(remote: string, name: string) {
    if (!folderPath.value) return;
    try {
      await gitDeleteRemoteTag(folderPath.value, remote, name);
      await loadLog();
    } catch (err: any) {
      error.value = `delete remote tag: ${err.message}`;
    }
  }

  async function renameBranch(oldName: string, newName: string) {
    if (!folderPath.value) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      await gitRenameBranch(folderPath.value, oldName, trimmed);
      await loadBranches();
      // If we just renamed the current branch, refresh status so branchDisplay updates.
      if (status.value?.branch === oldName) {
        await loadStatus(folderPath.value);
      }
      await loadLog();
    } catch (err: any) {
      error.value = `rename branch: ${err.message}`;
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
    logAuthorFilter,
    logHasMore,
    logLoadingMore,
    currentGitUser,
    loading,
    error,
    successMessage,
    viewMode,
    forcePushPreferred,
    isCommitting,
    isPushing,
    isPulling,
    isFetching,
    lastCommitHash,
    branches,
    branchesLoading,
    isSwitchingBranch,
    isMerging,
    worktreeBranches,
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
    needsPublish,
    aheadCount,
    behindCount,
    mainCommitCount,
    pushRemote,
    aheadPushCount,
    // Monorepo scope (v2.21.0)
    activeScope,
    totalUnscopedCount,
    scopedTotalCount,
    hiddenCommitCount,
    loadRevCounts,
    // Actions
    openRepo,
    closeRepo,
    refresh,
    selectFile,
    loadLog,
    loadMoreLog,
    setLogAuthorFilter,
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
    fetch: fetchRemote,
    mergeBranch,
    mergeContinue,
    abortMerge,
    discardFiles,
    addToGitignore,
    selectCommit,
    loadBranches,
    loadWorktrees,
    createBranch,
    switchBranch,
    deleteBranch,
    deleteRemoteBranch,
    deleteTag,
    deleteRemoteTag,
    renameBranch,
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
    popStash,
    dropStash,
  };
}
