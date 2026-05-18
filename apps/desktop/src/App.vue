<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, provide, defineAsyncComponent } from "vue";

// ─── Eager imports — main views & shared building blocks ─────────────────────
// These are part of the always-rendered UI (header, sidebar, main content
// panes, toasts, base modal). They must load with the initial bundle.
import AppHeader from "./components/AppHeader.vue";
import EmptyState from "./components/EmptyState.vue";
import RepoSidebar from "./components/RepoSidebar.vue";
import DiffViewer from "./components/DiffViewer.vue";
import AiSparkle from "./components/AiSparkle.vue";
import BaseModal from "./components/BaseModal.vue";
// Always-mounted (state-driven internally — must stay eager):
import EditCommitOverlay from "./components/EditCommitOverlay.vue";
import SplitCommitModal from "./components/SplitCommitModal.vue";

// ─── Type-only imports ───────────────────────────────────────────────────────
// SearchPalette exports a named type used in computed paletteActions.
// UpdateModal type is used to type the template ref for setProgress/setError.
import type { PaletteAction } from "./components/header/SearchPalette.vue";
import type UpdateModalType from "./components/UpdateModal.vue";

// ─── Lazy-loaded panels & modals (P2.4) ──────────────────────────────────────
// Each of these is gated by a v-if (or its parent is) and only mounted on
// user action — opening Settings, Help, a modal, the Search palette, etc.
// Splitting them out of the initial bundle shaves significant JS off the
// cold-start parse/eval cost. Vite handles the chunk separation automatically.
// ─── Main content views (lazy — rendered only when the matching viewMode/flag
// is active; never part of the initial paint) ─────────────────────────────────
const MergeEditor          = defineAsyncComponent(() => import("./components/MergeEditor.vue"));
const ImageDiffViewer      = defineAsyncComponent(() => import("./components/ImageDiffViewer.vue"));
const CommitDiffViewer     = defineAsyncComponent(() => import("./components/CommitDiffViewer.vue"));
const FileHistoryViewer    = defineAsyncComponent(() => import("./components/FileHistoryViewer.vue"));
const CommitGraph          = defineAsyncComponent(() => import("./components/CommitGraph.vue"));
const PrDetailView         = defineAsyncComponent(() => import("./components/PrDetailView.vue"));
const PrCreateView         = defineAsyncComponent(() => import("./components/PrCreateView.vue"));
const DashboardView        = defineAsyncComponent(() => import("./components/DashboardView.vue"));
const SettingsPanel        = defineAsyncComponent(() => import("./components/SettingsPanel.vue"));
const HelpView             = defineAsyncComponent(() => import("./components/HelpView.vue"));
const FolderPicker         = defineAsyncComponent(() => import("./components/FolderPicker.vue"));
const MergeSuccessModal    = defineAsyncComponent(() => import("./components/MergeSuccessModal.vue"));
const RebaseEditor         = defineAsyncComponent(() => import("./components/RebaseEditor.vue"));
const RebaseProgressModal  = defineAsyncComponent(() => import("./components/RebaseProgressBanner.vue"));
const StashManager         = defineAsyncComponent(() => import("./components/StashManager.vue"));
const TagsPanel            = defineAsyncComponent(() => import("./components/TagsPanel.vue"));
const WorktreeManager      = defineAsyncComponent(() => import("./components/WorktreeManager.vue"));
const SubmodulePanel       = defineAsyncComponent(() => import("./components/SubmodulePanel.vue"));
const WorkspacePanel       = defineAsyncComponent(() => import("./components/WorkspacePanel.vue"));
const LaunchpadView        = defineAsyncComponent(() => import("./components/LaunchpadView.vue"));
const AgentSessionsPanel   = defineAsyncComponent(() => import("./components/AgentSessionsPanel.vue"));
const CommandLogPanel      = defineAsyncComponent(() => import("./components/CommandLogPanel.vue"));
const SearchPalette        = defineAsyncComponent(() => import("./components/header/SearchPalette.vue"));
const BranchRenameModal    = defineAsyncComponent(() => import("./components/header/BranchRenameModal.vue"));
const BranchDeleteModal    = defineAsyncComponent(() => import("./components/header/BranchDeleteModal.vue"));
const CloneModal           = defineAsyncComponent(() => import("./components/CloneModal.vue"));
const ForkModal            = defineAsyncComponent(() => import("./components/ForkModal.vue"));
const GitTerminal          = defineAsyncComponent(() => import("./components/GitTerminal.vue"));
const UpdateModal          = defineAsyncComponent(() => import("./components/UpdateModal.vue"));
import { useStashMessage } from "./composables/useStashMessage";
import { useAIProvider } from "./composables/useAIProvider";
import { usePrPanel, PR_PANEL_KEY } from "./composables/usePrPanel";
import { useSplitCommit } from "./composables/useSplitCommit";
import type { GitLogEntry } from "./utils/backend";
import { getPersistedDiffMode, persistDiffMode, type DiffMode } from "./utils/diffMode";
import { isImagePath } from "./utils/imagePath";
import { useGitWand } from "./composables/useGitWand";
import { useRepoTabs } from "./composables/useRepoTabs";
import { useGitRepo, type ViewMode } from "./composables/useGitRepo";
import { useTheme } from "./composables/useTheme";
import { useI18n } from "./composables/useI18n";
import { useSettings } from "./composables/useSettings";
import { useNetworkStatus } from "./composables/useNetworkStatus";
import { useConnectivity } from "./composables/useConnectivity";
import { useScheduler } from "./composables/useScheduler";
import { useRepoPoller } from "./composables/useRepoPoller";
import { useReleaseNotes } from "./composables/useReleaseNotes";
import { useFolderHistory } from "./composables/useFolderHistory";
import { useAppMenu } from "./composables/useAppMenu";
import { useLogs } from "./composables/useLogs";
import {
  BRANCH_CREATE_REQUEST_KEY,
  MERGE_POPOVER_REQUEST_KEY,
  UNDO_POPOVER_REQUEST_KEY,
  LOG_FOCUS_SEARCH_KEY,
  LAUNCHPAD_OPEN_REQUEST_KEY,
} from "./composables/branchPickerBridge";
import { gitStash, gitStashPop, gitStashList, openInEditor, setGitConfig, gitDiscard, gitAddToGitignore, gitDeleteBranch, gitDeleteRemoteTag, gitRemoteInfo, gitUnpushedTags, gitPushTags, workspaceRead, gitMergeBase } from "./utils/backend";
import { useCommitActions } from "./composables/useCommitActions";

const { t } = useI18n();
const { settings, refreshSettings } = useSettings();
// `useNetworkStatus` covers `navigator.onLine` — kept around because
// `useScheduler` already consumes it and we don't want to retire that path
// in this commit. `useConnectivity` (F1) adds a real probe-based signal
// that flips to "offline" when the remote is unreachable even if the OS
// thinks the wifi is fine. We OR the two: any negative signal wins.
const { isOffline: navIsOffline } = useNetworkStatus();
const { isOnline: probedOnline, probeConnectivity } = useConnectivity();
const isOffline = computed(() => navIsOffline.value || !probedOnline.value);
import { isTauri, registerBrowserFolderPicker, pickFolder, checkForUpdates, fetchBetaUpdate, installUpdate, gitRepoState } from "./utils/backend";
import type { UpdateInfo, RepoOperationState, WorkspaceRepo } from "./utils/backend";
// UpdateModal moved above (lazy-loaded) — type imported as UpdateModalType for the template ref

const { theme, toggle: toggleTheme } = useTheme();

// ─── Merge conflict resolution (useGitWand) ─────────────
// Still used for conflict resolution, but auto-triggered, no mode switch
const {
  files: mergeFiles,
  selectedFile: mergeSelectedFile,
  stats: mergeStats,
  loading: mergeLoading,
  error: mergeError,
  canUndo,
  canRedo,
  openPath: mergeOpenPath,
  resolveAll,
  resolveFile,
  resolveHunkManual,
  resolveHunkCustom,
  saveFile,
  saveAllFiles,
  undo,
  redo,
  selectFile: mergeSelectFile,
  refreshLlmFallbackConfig: mergeRefreshLlmFallbackConfig,
} = useGitWand();

// ─── Repo mode (useGitRepo) — single shared instance ────
const {
  folderPath: repoFolderPath,
  status: repoStatus,
  selectedFilePath: repoSelectedFile,
  selectedFileStaged: repoSelectedFileStaged,
  diff: repoDiff,
  log: repoLog,
  logScope,
  logAuthorFilter,
  logHasMore,
  logLoadingMore,
  setLogAuthorFilter,
  loading: repoLoading,
  error: repoError,
  successMessage: repoSuccess,
  viewMode,
  hasRepo,
  branchDisplay,
  isClean,
  isSelectedFileConflicted,
  hasConflicts,
  allFiles: repoFiles,
  repoStats,
  commitSummary,
  commitDescription,
  canCommit,
  isCommitting,
  canPush,
  canPull,
  needsPublish,
  aheadCount,
  behindCount,
  pushRemote,
  aheadPushCount,
  isPushing,
  isPulling,
  isFetching,
  openRepo,
  closeRepo,
  refresh: repoRefresh,
  selectFile: repoSelectFile,
  loadLog,
  loadMoreLog,
  setLogScope,
  stageFiles,
  stageAll,
  unstageFiles,
  unstageAll,
  stagePatch,
  unstagePatch,
  commit: doCommit,
  amendCommit: doAmendCommit,
  push: doPush,
  pull: doPull,
  fetch: doFetch,
  mergeBranch: doMergeRaw,
  mergeContinue: doMergeContinue,
  abortMerge: doAbortMerge,
  cherryPick: doCherryPick,
  cherryPickAbort: doCherryPickAbort,
  cherryPickContinue: doCherryPickContinue,
  isCherryPicking,
  discardFiles,
  addToGitignore,
  branches,
  branchesLoading,
  isSwitchingBranch,
  isMerging,
  selectedCommitHash,
  commitDiffs,
  selectCommit,
  loadBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  renameBranch: doRenameBranch,
  currentGitUser,
} = useGitRepo();

// ─── Fork Point (v2.11) — graph view ─────────────────────
// SHA of the merge-base between HEAD and the upstream tracking branch.
// Used by CommitGraph to dim shared-history commits.
// Recomputed when branch changes. Empty string = no dimming (e.g. main branch).
const graphForkPointSha = ref<string>("");
watch(
  [branchDisplay, repoFolderPath],
  async ([branch, cwd]) => {
    if (!cwd || !branch) { graphForkPointSha.value = ""; return; }
    // Compare HEAD against the tracking remote branch; fall back to common names.
    const upstream = repoStatus.value?.remote ?? null;
    const candidates = upstream
      ? [upstream]
      : ["origin/main", "origin/master", "main", "master"];
    for (const ref of candidates) {
      try {
        const sha = await gitMergeBase(cwd, "HEAD", ref);
        if (sha) { graphForkPointSha.value = sha; return; }
      } catch { /* ignore */ }
    }
    graphForkPointSha.value = "";
  },
  { immediate: false },
);

// ─── PR panel (shared state via provide/inject) ──────────
const prCwd = computed(() => repoFolderPath.value ?? "");
const prPanel = usePrPanel(prCwd);
provide(PR_PANEL_KEY, prPanel);

// Load branches when the PR create form opens (they're needed to compute baseCandidates).
watch(() => prPanel.showCreateForm.value, (val) => {
  if (val && branches.value.length === 0) loadBranches();
});

// ─── Bridges: native menu → owning components ────────────
// Each counter is bumped by a menu action; the consumer watches and opens
// its popover / focuses its input. See branchPickerBridge.ts for the
// pattern. New bridges go in the same file — one symbol per surface.
const branchCreateRequest = ref(0);
const mergePopoverRequest = ref(0);
const undoPopoverRequest = ref(0);
const logFocusRequest = ref(0);
const launchpadOpenRequest = ref(0);
provide(BRANCH_CREATE_REQUEST_KEY, branchCreateRequest);
provide(MERGE_POPOVER_REQUEST_KEY, mergePopoverRequest);
provide(UNDO_POPOVER_REQUEST_KEY, undoPopoverRequest);
provide(LOG_FOCUS_SEARCH_KEY, logFocusRequest);
provide(LAUNCHPAD_OPEN_REQUEST_KEY, launchpadOpenRequest);

// ─── Multi-repo tabs (lightweight — paths only) ─────────
const {
  tabs: repoTabs,
  activeTabId,
  openTab,
  closeTab,
  switchTab,
} = useRepoTabs();

// When tab changes, load that repo into the single useGitRepo instance.
// If the user is currently on the history/graph view, also reload the log —
// otherwise the log would stay empty (openRepo clears it but doesn't refetch,
// and the viewMode watcher only fires on actual mode changes).
//
// When the last tab closes, `activeTabId` flips to null: close the repo so
// the main area reverts to EmptyState. Without this, the previously-loaded
// repo's state would linger (hasRepo stays true) and the user would still
// see its files/log even though no tab is active.
//
// `immediate: true` is how tab restore ties into the app boot: `useRepoTabs`
// hydrates `tabs` + `activeTabId` from localStorage at module load, so by
// the time this watcher registers there's already an active id waiting.
// Firing the callback immediately means the hydrated repo gets opened
// automatically — without it, tabs would appear in the strip but the main
// area would sit on EmptyState until the user clicks one. The handler is
// idempotent (checks `tab.path !== repoFolderPath.value` before calling
// `openRepo`, and only calls `closeRepo` when something is open), so
// running on boot is safe.
watch(
  activeTabId,
  async (id) => {
    if (id === null) {
      if (repoFolderPath.value) closeRepo();
      return;
    }
    const tab = repoTabs.value.find((t) => t.id === id);
    if (tab && tab.path !== repoFolderPath.value) {
      await openRepo(tab.path);
      if (viewMode.value === "history" || viewMode.value === "graph") {
        await loadLog();
      }
    }
  },
  { immediate: true },
);

// ─── Computed state ─────────────────────────────────────
const hasFiles = computed(() => repoFiles.value.length > 0);

/**
 * Files inside the currently-open untracked directory.
 * Persisted while navigating between sub-files — only cleared when
 * the selected file is outside the expanded directory.
 */
const expandedDirFiles = ref<string[]>([]);

watch(repoDiff, (diff) => {
  if (diff?.isDirectory && diff.newFiles?.length) {
    // Just opened a directory → remember its files
    expandedDirFiles.value = diff.newFiles ?? [];
  } else if (diff?.path && !expandedDirFiles.value.includes(diff.path)) {
    // Navigated to a file that is NOT one of the sub-files → collapse
    expandedDirFiles.value = [];
  }
  // If diff.path IS in expandedDirFiles → keep them (navigating within dir)
});

/** Name of the current folder (last segment of path). */
const folderName = computed(() => {
  const p = repoFolderPath.value;
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
});

// Auto-dismiss error after 3s
let errorTimer: ReturnType<typeof setTimeout> | null = null;
watch(repoError, (val) => {
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  if (val) {
    pushErrorLog(val);
    errorTimer = setTimeout(() => { repoError.value = null; }, 3000);
  }
});

/** Wrap the raw merge to capture the merged branch name for the cleanup modal. */
async function doMerge(branch: string) {
  lastMergedBranch.value = branch;
  await doMergeRaw(branch);
}

// ─── Merge success modal ──────────────────────────────────
const showMergeSuccess = ref(false);
/** Branch that was just merged — offered for cleanup in MergeSuccessModal. */
const lastMergedBranch = ref<string | null>(null);

function onMergeSuccessClose() {
  showMergeSuccess.value = false;
  lastMergedBranch.value = null;
  viewMode.value = "dashboard";
}

async function onMergeSuccessPush() {
  showMergeSuccess.value = false;
  lastMergedBranch.value = null;
  viewMode.value = "dashboard";
  await doPush();
}

async function onMergeSuccessDeleteBranch(branch: string, alsoRemote: boolean) {
  const cwd = repoFolderPath.value;
  if (!cwd || !branch) return;
  try {
    await gitDeleteBranch(cwd, branch, false);
    if (alsoRemote) {
      // git push <remote> --delete <branch> — same command as for tags
      const remoteInfo = await gitRemoteInfo(cwd);
      if (remoteInfo?.name) {
        await gitDeleteRemoteTag(cwd, remoteInfo.name, branch).catch(() => {/* best-effort */ });
      }
    }
    showMergeSuccess.value = false;
    lastMergedBranch.value = null;
    await loadBranches();
    viewMode.value = "dashboard";
  } catch (err: any) {
    repoError.value = err?.message ?? String(err);
  }
}

// Auto-dismiss success toast after 3s
const successToast = ref<string | null>(null);
const successToastDetail = ref<string | null>(null);
const successToastLeaving = ref(false);
let successTimer: number | null = null;

function dismissToast() {
  successToastLeaving.value = true;
  window.setTimeout(() => {
    successToast.value = null;
    successToastDetail.value = null;
    successToastLeaving.value = false;
    successTimer = null;
  }, 200);
}

watch(repoSuccess, (val) => {
  if (!val) return;
  // Consume the success signal regardless (so it doesn't pile up)
  repoSuccess.value = null;
  // Skip toast when the merge success modal is handling the feedback
  if (val === "merge-done" && showMergeSuccess.value) return;
  // Respect the notifications setting
  if (!settings.value.notifications) return;

  if (successTimer != null) { window.clearTimeout(successTimer); successTimer = null; }
  successToastLeaving.value = false;

  const meta: Record<string, { key: string; detail?: string }> = {
    "already-up-to-date": { key: "header.syncUpToDate" },
    "sync-done": { key: "header.syncDone" },
    "push-done": { key: "header.pushDone" },
    "merge-done": { key: "header.mergeDone" },
    "merge-aborted": { key: "header.mergeAborted" },
  };
  const info = meta[val];
  successToast.value = info ? t(info.key as any) : val;
  successToastDetail.value = new Date().toLocaleString(undefined, {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
  successTimer = window.setTimeout(dismissToast, 3000);
});

// ─── Conflict handling ──────────────────────────────────
// When a conflicted file is selected, load it in useGitWand for resolution
const showingMergeEditor = ref(false);

// Watch both the conflicted flag AND the selected file path —
// switching between two conflicted files keeps isConflicted=true
// so we need to also react to the file path changing.
watch(
  [isSelectedFileConflicted, repoSelectedFile],
  async ([isConflicted, filePath]) => {
    if (isConflicted && repoFolderPath.value && filePath) {
      await mergeOpenPath(repoFolderPath.value);
      mergeSelectFile(filePath);
      showingMergeEditor.value = true;
    } else {
      showingMergeEditor.value = false;
    }
  },
);

/**
 * After resolving a hunk or file, check if the file is fully resolved.
 * If so: save to disk, git add, refresh status, move to next conflicted file.
 */
async function checkAndSaveIfResolved(filePath: string) {
  const file = mergeFiles.value.find((f) => f.path === filePath);
  if (!file) return;

  // Still has unresolved conflict markers → nothing to do yet
  if (file.result.stats.totalConflicts > 0) return;

  // All conflicts resolved → save + stage
  if (!repoFolderPath.value) return;

  try {
    await saveFile(filePath);
    await stageFiles([filePath]);
    await repoRefresh();

    // Move to the next conflicted file, if any
    if (repoStatus.value && repoStatus.value.conflicted.length > 0) {
      await repoSelectFile(repoStatus.value.conflicted[0], false);
    } else if (isCherryPicking.value) {
      // Cherry-pick in progress — run cherry-pick --continue
      await doCherryPickContinue();
      // No merge-success modal for cherry-pick; a toast is enough
    } else {
      // Merge in progress — finalize the merge commit, then show modal
      await doMergeContinue();
      showMergeSuccess.value = true;
    }
  } catch (err: any) {
    repoError.value = `save: ${err?.message || String(err)}`;
  }
}

/** Wrapped resolve handlers that auto-save when fully resolved */
function handleResolveHunk(path: string, hunkIndex: number, choice: "ours" | "theirs" | "both" | "both-theirs-first") {
  resolveHunkManual(path, hunkIndex, choice);
  checkAndSaveIfResolved(path);
}

function handleResolveFile(path: string) {
  resolveFile(path);
  checkAndSaveIfResolved(path);
}

function handleResolveHunkCustom(path: string, hunkIndex: number, content: string) {
  resolveHunkCustom(path, hunkIndex, content);
  checkAndSaveIfResolved(path);
}

// ─── Edit commit overlay ────────────────────────────────
const editingCommit = ref<GitLogEntry | null>(null);

function handleEditCommit(entry: GitLogEntry) {
  editingCommit.value = entry;
}

async function handleAmendConfirm(summary: string, description: string) {
  editingCommit.value = null;
  await doAmendCommit(summary, description);
}

// ─── Split commit modal ─────────────────────────────────
const splitCommit = useSplitCommit();

/**
 * Open the split-commit modal for the commit the user right-clicked in the log.
 * Only supports splitting HEAD — the precondition is that the clicked commit
 * IS HEAD of the current branch. We verify here rather than leave it to the
 * backend so the user gets an immediate, actionable error before the modal
 * even opens.
 */
async function handleSplitCommitRequest(entry: GitLogEntry) {
  const cwd = repoFolderPath.value;
  if (!cwd) return;
  // Check: only allow splitting the top commit of the log (HEAD). Splitting
  // a past commit requires an interactive rebase edit-stop and is triggered
  // via the rebase editor, not the log context menu.
  const isHead = repoLog.value.length > 0 && repoLog.value[0].hashFull === entry.hashFull;
  if (!isHead) {
    repoError.value = t("splitCommit.errorNotHead");
    return;
  }
  // Refuse merge commits — splitting would flatten the merge and drop a
  // parent. The composable also guards on parents, but surfacing the error
  // at the app shell level means the user sees a repoError banner instead
  // of an orphan modal with an error slot.
  if ((entry.parents?.length ?? 0) > 1) {
    repoError.value = t("splitCommit.errorMergeCommit");
    return;
  }
  await splitCommit.openFor(cwd, {
    hash: entry.hashFull,
    message: entry.message,
    body: entry.body,
    parents: entry.parents,
  });
}

/**
 * Called after `git_split_commit` succeeds — refresh whatever view the user
 * is currently on so the two new commits show up. The modal closes itself
 * via the composable's `confirm()` before emitting this event.
 */
async function handleSplitCompleted(_hashes: { firstHash: string; secondHash: string }) {
  if (viewMode.value === "history" || viewMode.value === "graph") {
    await loadLog();
  }
  // Refresh branches too — if we split the HEAD commit on a branch tip,
  // the branch's resolved SHA will have changed.
  loadBranches();
}

function handleSplitClose() {
  // No-op — the composable already reset its own state on cancel.
}

// ─── Commit context menu — v1.9 ──────────────────────────

const {
  commitActionModal,
  closeCommitActionModal,
  handleCheckoutCommit,
  handleResetToCommit,
  handleRevertCommit,
  handleCreateBranchFromCommit,
  handleTagCommit,
  handleCherryPickCommit,
  handleViewOnForge,
  confirmCheckoutCommit,
  confirmResetToCommit,
  confirmCreateBranchFromCommit,
  confirmTagCommit,
  suggestTagWithAI,
  isTagAISuggesting,
  isAIAvailable,
} = useCommitActions({ repoFolderPath, repoError, loadLog, loadBranches, repoRefresh, cherryPick: doCherryPick });

// ─── Folder opening ─────────────────────────────────────
async function handleOpenFolder() {
  const path = await pickFolder();
  if (path) {
    openTab(path);
    await openRepo(path);
    if (viewMode.value === "history" || viewMode.value === "graph") {
      await loadLog();
    }
  }
}

async function handleOpenPath(path: string) {
  openTab(path);
  await openRepo(path);
  if (viewMode.value === "history" || viewMode.value === "graph") {
    await loadLog();
  }
}

// When switching tabs, load data as needed
watch(viewMode, async (mode) => {
  if ((mode === "history" || mode === "graph") && hasRepo.value) {
    await loadLog();
  }
  // Dashboard sidebar needs branches + recent log entries to show
  // pinned branches & activity feed.
  if (mode === "dashboard" && hasRepo.value) {
    if (branches.value.length === 0) loadBranches();
    if (repoLog.value.length === 0) loadLog();
  }
});

// Also refresh the dashboard sidebar data when the repo itself changes.
watch(hasRepo, (has) => {
  if (has && viewMode.value === "dashboard") {
    if (branches.value.length === 0) loadBranches();
    if (repoLog.value.length === 0) loadLog();
  }
});

// ─── Repo sidebar events ────────────────────────────────
function onRepoFileSelect(path: string, staged: boolean) {
  repoSelectFile(path, staged);
}

function onViewModeChange(mode: ViewMode) {
  viewMode.value = mode;
}

async function onDiscardSection(sectionKey: string, paths: string[]) {
  if (!window.confirm(t('sidebar.discardAllConfirm', paths.length))) return;
  if (sectionKey === 'staged') {
    await unstageFiles(paths);
  }
  await discardFiles(paths, sectionKey === 'untracked');
}

// ─── File history viewer ────────────────────────────────
const fileHistoryPath = ref<string | null>(null);

function openFileHistory(path: string) {
  fileHistoryPath.value = path;
}

function closeFileHistory() {
  fileHistoryPath.value = null;
}

async function handleOpenInEditor(path: string) {
  if (!repoFolderPath.value) return;
  try {
    await openInEditor(repoFolderPath.value, path, settings.value.editor);
  } catch (err: any) {
    repoError.value = `editor: ${err.message}`;
  }
}

// ─── Switch branch with behavior ────────────────────────
// Reads switchBehavior setting and applies stash / refuse / ask logic
// before delegating to the composable's switchBranch.

function isDirty(): boolean {
  const s = repoStatus.value;
  if (!s) return false;
  return s.staged.length > 0 || s.unstaged.length > 0 || s.untracked.length > 0;
}

async function handleSwitchBranch(name: string) {
  if (!repoFolderPath.value) return;
  const behavior = settings.value.switchBehavior;
  const dirty = isDirty();

  if (!dirty || behavior === "ask" && !dirty) {
    // Clean tree — just switch
    await switchBranch(name);
    return;
  }

  if (behavior === "refuse") {
    repoError.value = t("branches.switchRefusedDirty");
    return;
  }

  if (behavior === "stash") {
    // Open the stash-message modal; the actual stash/switch/pop is driven
    // by confirmSwitchStash() when the user confirms.
    pendingSwitchBranch.value = name;
    switchStashMessage.value = "";
    return;
  }

  if (behavior === "ask") {
    // Show a simple confirm — Vue dialog would be nicer but window.confirm is universal
    const msg = t("branches.switchConfirmDirty");
    if (window.confirm(msg)) {
      await switchBranch(name);
    }
    return;
  }

  // Fallback
  await switchBranch(name);
}

// ─── Sync-split button handlers (Phase 5) ─────────────────
//
// The header's SyncSplitButton is state-aware: computeSyncAction picks a
// primary action based on ahead/behind/needsPublish and can also surface
// "sync / fetch / rebase-onto-remote / merge-remote" from its dropdown.
// Each of those maps to a single handler here so the header stays a
// dumb composition — no git logic in components.
//
// NOTE: We don't have a dedicated `rebaseOntoRemote` / `mergeRemote`
// backend. Those are pull variants:
//   - rebaseOntoRemote → doPull(true)  (git pull --rebase)
//   - mergeRemote      → doPull(false) (git pull --no-rebase)
// This sidesteps the need for a new backend surface and Just Works™.

/**
 * Diverged-state primary action: pull (respecting user's pull mode) then
 * push. Kept in App.vue so the toast / error plumbing stays one layer up.
 */
async function doSync() {
  await doPull(pullMode.value === "rebase");
  // Only push if pull succeeded and there are local commits to push.
  if (!repoError.value && canPush.value) {
    await doPush();
  }
}

/** Publish a branch that doesn't yet have an upstream — same as push(). */
async function doPublish() {
  await doPush();
}

/** Dropdown "Rebase onto origin" — explicit rebase pull. */
async function doRebaseOntoRemote() {
  await doPull(true);
}

/** Dropdown "Merge origin into current" — explicit merge pull. */
async function doMergeRemote() {
  await doPull(false);
}

// ─── Current-branch rename / delete modals ───────────────
//
// Both are raised from BranchMenu → AppHeader. Modal confirms are the
// ones that actually call into git, so they live in App.vue where the
// composable handlers (doRenameBranch / deleteBranch) are in scope. We
// keep the `current-branch delete` separate from BranchSelector's
// per-branch delete: the selector already isolates the target in its
// popover, whereas the header action needs the type-name guard because
// it's always one click from a busy toolbar.
const showBranchRenameModal = ref(false);
const showBranchDeleteModal = ref(false);

async function onBranchRenameConfirm(oldName: string, newName: string) {
  // Identical to the BranchSelector rename path, just routed from the
  // modal. `doRenameBranch` handles the backend call, upstream update,
  // and status refresh.
  await doRenameBranch(oldName, newName);
}

async function onBranchDeleteConfirm(name: string) {
  // Reuse the same `deleteBranch` path the per-item BranchSelector
  // delete uses — the modal's guard is additive, not a replacement for
  // the backend's unmerged-work check.
  await deleteBranch(name);
}

// ─── Command palette (Cmd/Ctrl+K) ────────────────────────
//
// Owned here rather than inside AppHeader so every action has direct
// access to the same handlers (doPush, doSync, viewMode, showSettings…)
// the rest of the shell already uses. The palette is a dumb renderer:
// parent feeds it branches/commits/actions and routes emitted events to
// the matching handler. SearchPalette auto-closes on activate by
// emitting `close`, so handlers don't have to flip the ref themselves.
const showSearchPalette = ref(false);

/**
 * Open the palette. Triggered from the header SearchTrigger (which owns
 * the Cmd/Ctrl+K shortcut). Kick off lazy loads for branches and the log
 * if they're empty — otherwise the first-time user would open a palette
 * with only actions in it.
 */
function handleOpenSearch() {
  if (hasRepo.value) {
    if (branches.value.length === 0) loadBranches();
    if (repoLog.value.length === 0) loadLog();
  }
  showSearchPalette.value = true;
}

/**
 * Curated list of app-level actions exposed through the palette.
 * Labels are localized; gating (e.g., push only when there's something
 * to push, sync only when diverged) happens here so the palette itself
 * stays a dumb renderer. Order roughly follows "how often will the user
 * want this?" — remote sync first, views next, overlays last.
 */
const paletteActions = computed<PaletteAction[]>(() => {
  const out: PaletteAction[] = [];

  // With no repo open, the palette is essentially useless — offer the
  // one action that actually makes sense: open a folder.
  if (!hasRepo.value) {
    out.push({ id: "new-tab", label: t("header.paletteNewTab") });
    return out;
  }

  // Remote sync — only one primary action is offered at a time, matching
  // what SyncSplitButton does in the header.
  if (needsPublish.value) {
    out.push({ id: "push", label: t("header.publish"), hint: t("header.publishTooltip") });
  } else if (canPush.value && canPull.value) {
    out.push({ id: "sync", label: t("header.sync"), hint: t("header.syncTooltip") });
  } else if (canPush.value) {
    out.push({ id: "push", label: t("header.push") });
  } else if (canPull.value) {
    out.push({ id: "pull", label: t("header.pull") });
  }
  out.push({ id: "fetch", label: t("header.paletteFetch") });

  // View switchers — quick jumps between the four main modes.
  out.push(
    { id: "view-dashboard", label: t("header.paletteViewDashboard") },
    { id: "view-changes", label: t("header.paletteViewChanges") },
    { id: "view-log", label: t("header.paletteViewLog") },
    { id: "view-graph", label: t("header.paletteViewGraph") },
  );

  // Overlays
  out.push(
    { id: "open-stash", label: t("sidebar.stashTitle") },
    { id: "open-worktrees", label: t("worktree.title") },
    { id: "open-rebase", label: t("rebase.title") },
    { id: "open-settings", label: t("settings.title") },
  );

  // Universal: always available
  out.push({ id: "new-tab", label: t("header.paletteNewTab") });

  // Theme toggle — label reflects the target mode (what you'll flip TO).
  out.push({
    id: "toggle-theme",
    label: theme.value === "dark" ? t("header.themeLightLabel") : t("header.themeDarkLabel"),
  });

  return out;
});

/**
 * Route a palette action id to the matching app handler. Kept as an
 * explicit switch (not a Record lookup) so TypeScript exhaustiveness
 * would catch unhandled ids if we ever add discriminated unions later.
 */
function onPaletteAction(id: string) {
  switch (id) {
    case "push": handlePush(); break;
    case "pull": doPull(pullMode.value === "rebase"); break;
    case "sync": doSync(); break;
    case "fetch": doFetch(); break;
    case "new-tab": handleOpenFolder(); break;
    case "view-dashboard": viewMode.value = "dashboard"; break;
    case "view-changes": viewMode.value = "changes"; break;
    case "view-log": viewMode.value = "history"; break;
    case "view-graph": viewMode.value = "graph"; break;
    case "open-settings": showSettings.value = true; break;
    case "open-stash": showStash.value = true; break;
    case "open-worktrees": showWorktrees.value = true; break;
    case "open-rebase": showRebase.value = true; break;
    case "toggle-theme": toggleTheme(); break;
  }
}

/** Palette → branch switch: delegate to the dirty-tree-aware handler. */
function onPaletteSwitchBranch(name: string) {
  handleSwitchBranch(name);
}

/** Palette → commit select: jump to the history view focused on that commit. */
function onPaletteSelectCommit(hash: string) {
  selectCommit(hash);
  viewMode.value = "history";
}

// ─── Settings panel ─────────────────────────────────────
const showSettings = ref(false);
const settingsInitialTab = ref<"general" | "git" | "editor" | "ai" | "logs" | undefined>(undefined);

// ─── Error log (in-memory ring buffer, feeds SettingsPanel Logs tab) ─
// Uses the useLogs() singleton composable — no localStorage persistence so a
// reload starts with a clean buffer (errors from a previous session would
// otherwise surface as stale unread items).
const {
  entries: logEntries,
  unreadCount: logUnreadCount,
  log: pushLogEntry,
  clear: clearLogEntries,
  markAllRead: markLogsRead,
} = useLogs();

function pushErrorLog(msg: string) {
  pushLogEntry("error", msg);
}

function clearErrorLog() {
  clearLogEntries();
}

/** Opens Settings on the Logs tab and resets the unread badge. */
function openLogsTab() {
  settingsInitialTab.value = "logs";
  showSettings.value = true;
  markLogsRead();
}

// ─── Help panel ─────────────────────────────────────────
const showHelp = ref(false);

// ─── Integrated git terminal (v2.0) ──────────────────────
// Mounted as a docked panel below the main content when toggled on.
const showTerminal = ref(false);

// ─── Sidebar visibility (v2.0) ───────────────────────────
// View menu → Toggle Sidebar. Defaults to visible; we hide when the user
// wants more horizontal real estate for the diff / log views.
const showSidebar = ref(true);

// ─── Clone & Fork modals (v2.0) ──────────────────────────
const showCloneModal = ref(false);
const showForkModal = ref(false);

async function onCloned(path: string) {
  openTab(path);
  await openRepo(path);
  if (viewMode.value === "history" || viewMode.value === "graph") {
    await loadLog();
  }
}

async function onForked(path: string) {
  // Same flow as a clone — the upstream remote was already configured by
  // `gh repo fork --remote-name=upstream` on the backend.
  openTab(path);
  await openRepo(path);
  if (viewMode.value === "history" || viewMode.value === "graph") {
    await loadLog();
  }
}

// ─── Interactive rebase panel ────────────────────────────
const showRebase = ref(false);

// ─── Rebase-in-progress state (plain rebase from pull --rebase) ──────────
// Polled after every repo refresh so the banner appears/disappears automatically.
const repoOperationState = ref<RepoOperationState | null>(null);
const showRebaseBanner = computed(() =>
  repoOperationState.value !== null &&
  (repoOperationState.value.state === "rebase" || repoOperationState.value.state === "rebase_interactive") &&
  !showRebase.value &&   // don't overlap with the RebaseEditor (user-initiated interactive rebase)
  repoFolderPath.value !== ""
);

async function refreshRepoState() {
  if (!repoFolderPath.value) { repoOperationState.value = null; return; }
  try {
    const state = await gitRepoState(repoFolderPath.value);
    // Surface both plain and interactive rebase states — git ≥2.26 uses the
    // sequencer backend (creates rebase-merge/interactive) even for plain
    // pull --rebase.  We distinguish from a user-initiated RebaseEditor session
    // via the showRebase flag (see showRebaseBanner computed above).
    repoOperationState.value =
      (state.state === "rebase" || state.state === "rebase_interactive") ? state : null;
  } catch (err) {
    console.warn("[rebase] gitRepoState error:", err);
    repoOperationState.value = null;
  }
}

async function onRebaseBannerActionDone() {
  // After continue/abort/skip: re-poll state, refresh repo
  await refreshRepoState();
  await repoRefresh();
}

// ─── Rebase-state polling ────────────────────────────────────────────────────
// Declared here (after repoOperationState + refreshRepoState) so the
// { immediate: true } watch can safely reference both without TDZ errors.
//
// Strategy: we DON'T poll continuously. Instead we rely on:
//   1. A one-shot refresh when the repo opens (covers "app launched mid-rebase")
//   2. watch(repoStatus, …) that reruns refreshRepoState whenever git status
//      output changes — this picks up the START of any rebase/merge/cherry-pick
//      triggered from the app or from an external terminal (pollStatus runs
//      every 2 s in useGitRepo).
//   3. A 3 s belt-and-suspenders interval that ONLY runs while an operation
//      is in progress (repoOperationState !== null). During a rebase-with-
//      conflicts the porcelain status output is perfectly stable, so the
//      watch above wouldn't fire on its own and we need this interval to
//      keep step/total fresh and to detect --continue / --abort completion
//      within 3 seconds.
//
// Rationale: in normal use (~99 % of the time), no rebase is in progress, so
// this saves ~20 git invokes/min in the background.
let _rebaseStateInterval: ReturnType<typeof setInterval> | null = null;

watch(
  () => repoFolderPath.value,
  (path) => {
    if (_rebaseStateInterval) { clearInterval(_rebaseStateInterval); _rebaseStateInterval = null; }
    if (path) {
      refreshRepoState();                                     // immediate check on repo open
    } else {
      repoOperationState.value = null;
    }
  },
  { immediate: true },
);
// Also re-check whenever status changes (e.g. user stages a resolved file) so
// the Continue button enables without waiting for the next 3-second tick.
watch(repoStatus, () => { refreshRepoState(); }, { deep: false });

// Start/stop the 3 s belt-and-suspenders poll based on whether an operation
// is actually in progress. When idle, no interval runs at all.
watch(repoOperationState, (op) => {
  if (op && !_rebaseStateInterval) {
    _rebaseStateInterval = setInterval(refreshRepoState, 3_000);
  } else if (!op && _rebaseStateInterval) {
    clearInterval(_rebaseStateInterval);
    _rebaseStateInterval = null;
  }
});

// ─── Stash manager panel ────────────────────────────────
const showStash = ref(false);
const showTags = ref(false);
const showWorkspace = ref(false);
const showAgents = ref(false);
const showCommandLog = ref(false);

const stashCount = ref(0);
async function loadStashCount() {
  if (!repoFolderPath.value) { stashCount.value = 0; return; }
  try {
    const list = await gitStashList(repoFolderPath.value);
    stashCount.value = Array.isArray(list) ? list.length : 0;
  } catch {
    stashCount.value = 0;
  }
}
watch(repoFolderPath, loadStashCount, { immediate: true });
watch(
  () => repoStats.value.staged + repoStats.value.unstaged + repoStats.value.untracked + repoStats.value.conflicted,
  loadStashCount,
);

// ─── Launchpad panel ─────────────────────────────────────
// showLaunchpad removed — Launchpad is now a first-class viewMode ("launchpad").
// launchpadRepos holds the workspace repos list loaded on demand; the
// <LaunchpadView :repos="…"> in the main-content area consumes it.
const launchpadRepos = ref<WorkspaceRepo[]>([]);
function openLaunchpad(repos: WorkspaceRepo[]) {
  launchpadRepos.value = repos;
  viewMode.value = "launchpad";
  showWorkspace.value = false;
}

/**
 * Handle the ⌘L / Ctrl+L shortcut.
 *
 * Resolves the active workspace lazily — Launchpad needs the repo list and
 * the user might have a workspace persisted from a previous session that
 * App.vue hasn't loaded yet (WorkspacePanel owns that state). We read the
 * same localStorage key WorkspacePanel uses (`gitwand-workspace-dir`) and
 * call `workspaceRead` directly. If no workspace is configured, surface a
 * warning in the existing error-toast and pop WorkspacePanel so the user
 * can create one.
 */
async function handleLaunchpadShortcut(): Promise<void> {
  // If Launchpad already open with repos, just keep it visible (no-op).
  if (viewMode.value === "launchpad" && launchpadRepos.value.length > 0) return;

  // Re-use repos already loaded for this session (e.g. WorkspacePanel was
  // opened earlier) — fastest path, no IPC.
  if (launchpadRepos.value.length > 0) {
    openLaunchpad(launchpadRepos.value);
    return;
  }

  const savedDir = localStorage.getItem("gitwand-workspace-dir");
  if (savedDir) {
    try {
      const cfg = await workspaceRead(savedDir);
      if (cfg.repos.length > 0) {
        openLaunchpad(cfg.repos);
        return;
      }
    } catch {
      // Fall through to the no-workspace branch — best-effort.
    }
  }

  // No workspace defined (or empty) → toast + open WorkspacePanel so the
  // user can configure one. Reuses the error-toast pipeline so the message
  // dismisses on its own after 3s.
  repoError.value = t("launchpad.noWorkspace.warning");
  showWorkspace.value = true;
}

// Watch the bridge counter — each menu invocation bumps it and triggers a
// fresh handler call, even when the value is already non-zero.
watch(launchpadOpenRequest, () => {
  void handleLaunchpadShortcut();
});

// ─── Worktree manager panel ──────────────────────────────
const showWorktrees = ref(false);
const pendingWorktreeBranch = ref<string | undefined>(undefined);
const pendingQuickCreate = ref(false);

// ─── Submodule panel ─────────────────────────────────────
const showSubmodules = ref(false);

// ─── Push + tags confirmation modal ─────────────────────
const pushTagsConfirm = ref(false);
const pendingUnpushedTags = ref<string[]>([]);

/**
 * Intercepts the normal push flow:
 * 1. Checks for unpushed local tags.
 * 2. If any exist, shows a confirmation modal instead of pushing immediately.
 * 3. Otherwise falls through to the regular push.
 */
async function handlePush() {
  const cwd = repoFolderPath.value;
  if (!cwd) return;
  try {
    const remoteInfo = await gitRemoteInfo(cwd).catch(() => null);
    const remote = remoteInfo?.name || "origin";
    const unpushed = await gitUnpushedTags(cwd, remote).catch(() => [] as string[]);
    if (unpushed.length > 0) {
      pendingUnpushedTags.value = unpushed;
      pushTagsConfirm.value = true;
      return;
    }
  } catch { /* best-effort — fall through to normal push */ }
  await doPush();
}

async function confirmPushWithTags() {
  const cwd = repoFolderPath.value;
  pushTagsConfirm.value = false;
  await doPush();
  if (cwd) {
    const remoteInfo = await gitRemoteInfo(cwd).catch(() => null);
    const remote = remoteInfo?.name || "origin";
    await gitPushTags(cwd, remote, "all").catch((err: any) => {
      repoError.value = `push tags: ${err?.message ?? err}`;
    });
  }
  pendingUnpushedTags.value = [];
  // Trigger scheduled release notes if the user just pushed a version tag
  triggerReleaseNotesIfEnabled();
}

async function confirmPushWithoutTags() {
  pushTagsConfirm.value = false;
  pendingUnpushedTags.value = [];
  await doPush();
}

// ─── Stash-and-switch modal (Phase 1.3.3) ──────────────
const pendingSwitchBranch = ref<string | null>(null);
const switchStashMessage = ref("");
const {
  isGenerating: isGeneratingSwitchStashMessage,
  generate: generateSwitchStashMessage,
  lastError: switchStashAiError,
} = useStashMessage();
const aiProvider = useAIProvider();
const { locale: uiLocale } = useI18n();

async function suggestSwitchStashMessage() {
  if (!repoFolderPath.value) return;
  try {
    const suggestion = await generateSwitchStashMessage(repoFolderPath.value, {
      locale: uiLocale.value,
    });
    if (suggestion) switchStashMessage.value = suggestion;
  } catch {
    // Error already captured on the composable — surfaced via switchStashAiError
  }
}

async function confirmSwitchStash() {
  const name = pendingSwitchBranch.value;
  if (!name || !repoFolderPath.value) return;
  const msg = switchStashMessage.value;
  pendingSwitchBranch.value = null;
  switchStashMessage.value = "";
  isSwitchingBranch.value = true;
  try {
    await gitStash(repoFolderPath.value, msg);
    await switchBranch(name);
    await gitStashPop(repoFolderPath.value);
  } catch (err: any) {
    repoError.value = `switch (stash): ${err.message}`;
  } finally {
    isSwitchingBranch.value = false;
  }
}

function cancelSwitchStash() {
  pendingSwitchBranch.value = null;
  switchStashMessage.value = "";
}

/**
 * Global Escape handler — closes the topmost open overlay. Preferred
 * over per-component `@keydown.esc` because those only fire while a
 * specific input inside the modal has focus; Escape should work from
 * anywhere. Priority follows z-index: switch-stash (45) beats stash
 * manager (40).
 */
function onGlobalKeydown(e: KeyboardEvent) {
  // ⌘⇧L / Ctrl+Shift+L — toggle Command Log panel
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && (e.key === "L" || e.key === "l")) {
    e.preventDefault();
    showCommandLog.value = !showCommandLog.value;
    return;
  }
  if (e.key !== "Escape") return;
  if (showCommandLog.value) {
    showCommandLog.value = false;
    return;
  }
  if (showHelp.value) {
    showHelp.value = false;
    return;
  }
  if (pendingSwitchBranch.value) {
    cancelSwitchStash();
    return;
  }
  if (showStash.value) {
    showStash.value = false;
    return;
  }
}
onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onUnmounted(() => window.removeEventListener("keydown", onGlobalKeydown));

function handleRebaseDone() {
  showRebase.value = false;
  repoRefresh();
}
const diffMode = ref<DiffMode>(getPersistedDiffMode());

function onDiffModeChange(mode: DiffMode) {
  diffMode.value = mode;
  persistDiffMode(mode);
}

// Pull mode (merge/rebase) — read from settings localStorage
function getPersistedPullMode(): "merge" | "rebase" {
  try {
    const raw = localStorage.getItem("gitwand-settings");
    if (raw) {
      const s = JSON.parse(raw);
      if (s.pullMode === "rebase") return "rebase";
    }
  } catch { /* ignore */ }
  return "merge";
}
const pullMode = ref<"merge" | "rebase">(getPersistedPullMode());

function onPullModeChange(mode: "merge" | "rebase") {
  pullMode.value = mode;
}

// Font size & tab size — apply as CSS custom properties
function getPersistedFontSize(): number {
  try {
    const raw = localStorage.getItem("gitwand-settings");
    if (raw) { const s = JSON.parse(raw); if (s.fontSize) return s.fontSize; }
  } catch { /* ignore */ }
  return 12;
}
function getPersistedTabSize(): number {
  try {
    const raw = localStorage.getItem("gitwand-settings");
    if (raw) { const s = JSON.parse(raw); if (s.tabSize) return s.tabSize; }
  } catch { /* ignore */ }
  return 4;
}

const fontSize = ref(getPersistedFontSize());
const tabSize = ref(getPersistedTabSize());

function applyCodeStyles() {
  document.documentElement.style.setProperty("--code-font-size", `${fontSize.value}px`);
  document.documentElement.style.setProperty("--code-tab-size", `${tabSize.value}`);
}
applyCodeStyles();

function onFontSizeChange(size: number) {
  fontSize.value = size;
  applyCodeStyles();
}

function onTabSizeChange(size: number) {
  tabSize.value = size;
  applyCodeStyles();
}

const COMMIT_SIGNATURE = "\u{1FA84} Commit via GitWand";
function onCommitSignatureChange(enabled: boolean) {
  if (enabled) {
    if (!commitDescription.value) {
      commitDescription.value = COMMIT_SIGNATURE;
    }
  } else {
    if (commitDescription.value === COMMIT_SIGNATURE) {
      commitDescription.value = "";
    }
  }
}

// ─── Folder picker (browser mode) ───────────────────────
const showFolderPicker = ref(false);
let folderPickerResolve: ((path: string | null) => void) | null = null;

if (!isTauri()) {
  registerBrowserFolderPicker(() => {
    return new Promise<string | null>((resolve) => {
      folderPickerResolve = resolve;
      showFolderPicker.value = true;
    });
  });
}

function onFolderSelected(path: string) {
  showFolderPicker.value = false;
  folderPickerResolve?.(path);
  folderPickerResolve = null;
}

function onFolderPickerCancel() {
  showFolderPicker.value = false;
  folderPickerResolve?.(null);
  folderPickerResolve = null;
}

// ─── Keyboard shortcuts ──────────────────────────────────
function onKeyDown(e: KeyboardEvent) {
  if (showFolderPicker.value) return;
  const mod = e.metaKey || e.ctrlKey;
  // NOTE: Cmd/Ctrl+K is intentionally NOT bound here — it's reserved for
  // the command palette (SearchTrigger owns that shortcut). Open-folder
  // is reachable via Cmd+T (new tab) below, which matches the browser
  // "new tab" convention users already know.
  if (mod && e.key === "t") {
    // Cmd+T — new tab (open folder picker)
    e.preventDefault();
    handleOpenFolder();
  } else if (mod && e.key === "w") {
    // Cmd+W — close active tab
    e.preventDefault();
    if (activeTabId.value !== null) {
      closeTab(activeTabId.value);
    }
  } else if (mod && e.key === "z" && !e.shiftKey && showingMergeEditor.value) {
    e.preventDefault();
    undo();
  } else if (mod && e.key === "z" && e.shiftKey && showingMergeEditor.value) {
    e.preventDefault();
    redo();
  } else if (mod && e.key === "y" && showingMergeEditor.value) {
    e.preventDefault();
    redo();
  } else if (mod && e.key === "s") {
    e.preventDefault();
    if (showingMergeEditor.value) saveAllFiles();
  } else if (mod && e.shiftKey && e.key === "N") {
    // Cmd/Ctrl+Shift+N — quick-create worktree
    if (hasRepo.value) {
      e.preventDefault();
      pendingQuickCreate.value = true;
      showWorktrees.value = true;
    }
  } else if (mod && e.key >= "1" && e.key <= "9") {
    // Cmd+1..9 — switch to tab by position
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx < repoTabs.value.length) {
      switchTab(repoTabs.value[idx].id);
    }
  }
}

// Push git path to Tauri backend on startup and when settings change
async function applyGitConfig() {
  try {
    await setGitConfig(settings.value.gitPath);
  } catch {
    // Non-fatal — falls back to system "git"
  }
}

function onSettingsClose() {
  showSettings.value = false;
  refreshSettings();
  applyGitConfig();
  // v2.5 — `.gitwandrc.llmFallback` may have been edited in the AI tab.
  // Re-read it so the next merge resolution picks up the new config
  // without needing to re-open the repo. Fire-and-forget — failure is
  // already handled silently inside the composable.
  void mergeRefreshLlmFallbackConfig();
}


// ─── Scheduler (v2.8) ────────────────────────────────────
const { generate: generateReleaseNotesFn } = useReleaseNotes();

const scheduler = useScheduler({
  cwd: repoFolderPath as import("vue").Ref<string>,
  settings,
  isOffline,
  onLog: (msg) => pushErrorLog(msg),
  resolveConflicts: async () => {
    if (!repoFolderPath.value) return;
    await resolveAll();
    await repoRefresh();
  },
  pullAndRebase: async () => {
    await doPull(true);
  },
  generateReleaseNotes: async () => {
    if (!repoFolderPath.value) return;
    // Get last two tags and generate notes between them
    const { gitListTags } = await import("./utils/backend");
    const tags = await gitListTags(repoFolderPath.value);
    if (tags.length < 2) return;
    const sorted = [...tags].sort((a, b) => b.date.localeCompare(a.date));
    await generateReleaseNotesFn(repoFolderPath.value, sorted[1].name, sorted[0].name);
  },
  triggerAiCommit: async () => {
    // Surface the commit panel — the user will see staged files there
    // and can use the AI commit button manually. A background generation
    // would require a ref into the sidebar; this is the least-invasive UX.
    showSettings.value = false;
  },
  hasStagedFiles: () => (repoStatus.value?.staged.length ?? 0) > 0,
});
const { triggerReleaseNotesIfEnabled } = scheduler;

// ─── Consolidated poller (§2.1) — single 2s interval replacing 5 independent polls ──
const poller = useRepoPoller({
  onStatusChange: async (cwd) => {
    await repoRefresh();
  },
  onConflictDetected: async (_cwd) => {
    // scheduler.onConflictDetected reads cwd from its callback ref
    // (cb.cwd) so we don't pass it explicitly here.
    await scheduler.onConflictDetected();
  },
  onFetchTick: async (cwd) => {
    await doFetch();
  },
  onNightlyTick: async () => {
    await scheduler.onNightlyTick();
  },
  // F1 — connectivity probe runs on the same 2 s heartbeat, throttled to
  // ~30 s ticks inside useRepoPoller. Skips itself when no repo is active.
  onConnectivityTick: async (cwd) => {
    await probeConnectivity(cwd);
  },
});
watch(repoFolderPath, (p) => poller.setFolderPath(p), { immediate: true });

// ─── Global shortcut listener (Cmd+Shift+G from anywhere) ─
let unlistenGlobalShortcut: (() => void) | null = null;

async function setupGlobalShortcutListener() {
  if (!isTauri()) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenGlobalShortcut = await listen("global-shortcut-activate", () => {
      // GitWand was activated via Cmd+Shift+G — if no repo is open, open the folder picker
      if (!hasRepo.value) {
        handleOpenFolder();
      }
    });
  } catch {
    // Global shortcut listener not available (e.g. browser dev mode)
  }
}

// ─── In-app updater ────────────────────────────────────────────────────────
const pendingUpdate = ref<UpdateInfo | null>(null);
const updateModalRef = ref<InstanceType<typeof UpdateModalType> | null>(null);

async function runUpdateCheck() {
  // Stable channel uses the Tauri plugin's auto-install path; beta channel
  // fetches a separate manifest and points the user at the GitHub release
  // for manual install (Tauri's plugin can't be retargeted at runtime).
  const channel = settings.value?.updateChannel ?? "stable";
  const info = channel === "beta"
    ? await fetchBetaUpdate(__APP_VERSION__)
    : await checkForUpdates();
  if (info) pendingUpdate.value = info;
}

async function onInstallUpdate() {
  // Manual install path (beta channel): just open the GitHub release page.
  // The user downloads + installs themselves; we close our modal.
  if (pendingUpdate.value?.installMethod === "manual") {
    if (pendingUpdate.value.downloadUrl) {
      window.open(pendingUpdate.value.downloadUrl, "_blank");
    }
    pendingUpdate.value = null;
    return;
  }
  // Auto-install path (stable channel): Tauri downloads + replaces in place.
  try {
    await installUpdate((fraction) => {
      updateModalRef.value?.setProgress(fraction);
    });
  } catch (err) {
    // relaunch() failed after a successful download (e.g. macOS Gatekeeper delay).
    // Reset the modal so the user isn't stuck on an infinite spinner, and surface
    // a dismissible message explaining they need to reopen manually.
    updateModalRef.value?.setRelaunchError(String(err));
  }
  // installUpdate either relaunches (normal) or throws (caught above).
  // Either way, clear the pending update so the modal can be closed.
  pendingUpdate.value = null;
}

// ─── Native macOS menu bar ─────────────────────────────────────────────────
// Builds the File / Edit / Repository / View / Window / Help menus. macOS
// only — no-op on Linux/Windows where the AppHeader carries the chrome.
const { clearHistory: clearFolderHistory } = useFolderHistory();
useAppMenu(
  {
    openFolder: handleOpenFolder,
    openRecentFolder: handleOpenPath,
    clearRecents: clearFolderHistory,
    openClone: () => {
      showCloneModal.value = true;
    },
    openFork: () => {
      showForkModal.value = true;
    },
    closeWindow: () => {
      if (activeTabId.value !== null) closeTab(activeTabId.value);
    },
    fetch: doFetch,
    pull: () => doPull(pullMode.value === "rebase"),
    push: doPush,
    newBranch: () => {
      // Bump the bridge counter; BranchSelector opens its inline create
      // form (popover + create-input visible, autofocused).
      branchCreateRequest.value++;
    },
    openOnForge: async () => {
      if (!repoFolderPath.value) return;
      const info = await gitRemoteInfo(repoFolderPath.value);
      if (!info.owner || !info.repo) return;
      const url =
        info.provider === "gitlab"
          ? `https://gitlab.com/${info.owner}/${info.repo}`
          : info.provider === "bitbucket"
            ? `https://bitbucket.org/${info.owner}/${info.repo}`
            : `https://github.com/${info.owner}/${info.repo}`;
      window.open(url, "_blank");
    },
    toggleTheme,
    checkForUpdates: runUpdateCheck,
    openHelp: () => {
      showHelp.value = true;
    },
    openSettings: () => {
      showSettings.value = true;
    },
    // ── 5 deferred items, now wired ──
    openTerminal: () => {
      showTerminal.value = true;
    },
    toggleSidebar: () => {
      showSidebar.value = !showSidebar.value;
    },
    findInLog: () => {
      // Switch to the log/history view first — focusing a hidden input
      // would silently no-op because the element isn't mounted.
      viewMode.value = "history";
      logFocusRequest.value++;
    },
    openUndoStack: () => {
      undoPopoverRequest.value++;
    },
    openMerge: () => {
      mergePopoverRequest.value++;
    },
    openLaunchpad: () => {
      // Bump the bridge counter; the watcher above resolves the active
      // workspace and either opens Launchpad or surfaces the no-workspace
      // toast. The accelerator stays mapped in all cases so muscle memory
      // works even before a workspace is configured.
      launchpadOpenRequest.value++;
    },
  },
  { hasRepo },
);

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  applyGitConfig();
  setupGlobalShortcutListener();
  // Check for updates after a short delay so the app renders first.
  setTimeout(() => runUpdateCheck(), 5_000);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
  unlistenGlobalShortcut?.();
  if (_rebaseStateInterval) { clearInterval(_rebaseStateInterval); _rebaseStateInterval = null; }
});
</script>

<template>
  <div class="app">
    <AppHeader :has-files="hasFiles" :theme="theme" :branch-display="branchDisplay" :repo-stats="repoStats"
      :has-repo="hasRepo" :folder-name="folderName" :can-push="canPush" :can-pull="canPull"
      :needs-publish="needsPublish" :ahead-count="aheadCount" :behind-count="behindCount" :push-remote="pushRemote"
      :ahead-push-count="aheadPushCount" :is-pushing="isPushing" :is-pulling="isPulling" :is-fetching="isFetching"
      :cwd="repoFolderPath ?? ''" :branches="branches" :branches-loading="branchesLoading"
      :is-switching-branch="isSwitchingBranch" :is-merging="isMerging" :tabs="repoTabs" :active-tab-id="activeTabId"
      @open-folder="handleOpenFolder" @open-repo="handleOpenPath" @switch-tab="switchTab" @close-tab="closeTab"
      @new-tab="handleOpenFolder" @open-clone="showCloneModal = true" @open-fork="showForkModal = true"
      @toggle-theme="toggleTheme" @push="handlePush" @pull="() => doPull(pullMode === 'rebase')" @fetch="doFetch"
      @sync="doSync" @publish="doPublish" @rebase-onto-remote="doRebaseOntoRemote" @merge-remote="doMergeRemote"
      @merge-branch="doMerge" @open-settings="settingsInitialTab = undefined; showSettings = true"
      :error-count="logUnreadCount" :is-offline="isOffline" @switch-branch="handleSwitchBranch"
      @open-logs="openLogsTab"
      @create-branch="createBranch" @delete-branch="deleteBranch" @open-rename-modal="showBranchRenameModal = true"
      @open-delete-modal="showBranchDeleteModal = true" @load-branches="loadBranches" @undo-performed="repoRefresh()"
      @open-rebase="showRebase = true"
      @open-worktrees="(branch) => { pendingWorktreeBranch = branch; showWorktrees = true; }"
      @open-submodules="showSubmodules = true" @open-search="handleOpenSearch" @open-help="showHelp = true"
      :stash-count="stashCount"
      @open-stash="showStash = true" @open-tags="showTags = true"
      @open-workspace="showWorkspace = true" @open-agents="showAgents = true" />

    <div class="app-body">
      <aside class="sidebar" v-if="hasRepo && showSidebar">
        <RepoSidebar :cwd="repoFolderPath ?? ''" :files="repoFiles" :selected-file="repoSelectedFile"
          :view-mode="viewMode" :repo-stats="repoStats" :commit-summary="commitSummary"
          :commit-description="commitDescription" :can-commit="canCommit" :is-committing="isCommitting"
          :log-entries="repoLog" :log-loading="repoLoading" :log-scope="logScope" :log-author-filter="logAuthorFilter"
          :log-has-more="logHasMore" :log-loading-more="logLoadingMore" @load-more-log="loadMoreLog"
          :current-branch="repoStatus?.branch ?? ''" :selected-commit-hash="selectedCommitHash"
          :ahead-count="aheadCount" :needs-publish="needsPublish" :dir-files="expandedDirFiles" :branches="branches"
          @select="onRepoFileSelect" @change-view="onViewModeChange"
          @select-dir-file="(path) => repoSelectFile(path, false)" @stage-file="(path) => stageFiles([path])"
          @unstage-file="(path) => unstageFiles([path])" @stage-all="stageAll"
          @stage-paths="(paths) => stageFiles(paths)" @unstage-all="unstageAll" :git-user="currentGitUser"
          @commit="(trailers) => doCommit(trailers)" @update:commit-summary="(val) => commitSummary = val"
          @update:commit-description="(val) => commitDescription = val" @select-commit="selectCommit"
          @edit-commit="handleEditCommit" @split-commit="handleSplitCommitRequest"
          @checkout-commit="handleCheckoutCommit" @reset-to-commit="handleResetToCommit"
          @revert-commit="handleRevertCommit" @create-branch-from-commit="handleCreateBranchFromCommit"
          @tag-commit="handleTagCommit" @cherry-pick-commit="handleCherryPickCommit" @view-on-forge="handleViewOnForge"
          @update:log-scope="setLogScope" @update:log-author-filter="setLogAuthorFilter"
          @discard="(path, section) => discardFiles([path], section === 'untracked')"
          @discard-section="onDiscardSection"
          @add-to-gitignore="(path) => addToGitignore(path)" @refresh="repoRefresh()" @open-stash="showStash = true"
          @open-tags="showTags = true" @open-workspace="showWorkspace = true" @open-agents="showAgents = true"
          @open-launchpad="handleLaunchpadShortcut" />
      </aside>

      <main class="main">
        <!-- No repo loaded → EmptyState full screen -->
        <EmptyState v-if="!hasRepo && !repoLoading" @open-folder="handleOpenFolder" @open-path="handleOpenPath"
          @open-clone="showCloneModal = true" @open-fork="showForkModal = true" />

        <template v-else>
          <div v-if="repoLoading" class="loading-overlay">
            <div class="loading-spinner"></div>
            <span class="loading-text">{{ t('merge.loadingRepo') }}</span>
          </div>

          <template v-else>
            <Transition name="error-toast">
              <div v-if="repoError" class="error-toast" role="alert">
                <svg class="error-toast-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.4" />
                  <path d="M7 4v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                  <circle cx="7" cy="9.5" r="0.75" fill="currentColor" />
                </svg>
                <span class="error-toast-text">{{ repoError }}</span>
                <button class="error-toast-logs" @click="openLogsTab"
                  :title="t('error.viewLogs')">
                  {{ t('error.viewLogs') }}
                </button>
                <button class="error-toast-close" @click="repoError = null" :aria-label="t('common.close')">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <path
                      d="M2.646 2.646a.5.5 0 01.708 0L6 5.293l2.646-2.647a.5.5 0 01.708.708L6.707 6l2.647 2.646a.5.5 0 01-.708.708L6 6.707 3.354 9.354a.5.5 0 01-.708-.708L5.293 6 2.646 3.354a.5.5 0 010-.708z" />
                  </svg>
                </button>
              </div>
            </Transition>

            <!-- Conflict banner (merge or cherry-pick) -->
            <div v-if="hasConflicts" class="conflict-banner" role="alert">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <path d="M9 1.5L16.5 15H1.5L9 1.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                <path d="M9 7v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                <circle cx="9" cy="12.5" r="0.75" fill="currentColor" />
              </svg>
              <span class="conflict-text">
                {{ repoStats.conflicted }} {{ repoStats.conflicted > 1 ? t('header.conflicts') : t('header.conflict') }}
                — {{ t('header.resolveConflicts') }}
              </span>
              <button v-if="isCherryPicking" class="conflict-abort-btn" @click="doCherryPickAbort">
                {{ t('header.abortCherryPick') }}
              </button>
              <button v-else class="conflict-abort-btn" @click="doAbortMerge">
                {{ t('header.abortMerge') }}
              </button>
            </div>

            <!-- Dashboard view (default when opening a repo) -->
            <DashboardView v-if="viewMode === 'dashboard'" :cwd="repoFolderPath ?? ''" :branch="branchDisplay"
              :status="repoStats" :ahead="aheadCount" :behind="behindCount" :needs-publish="needsPublish"
              @change-view="onViewModeChange" @push="handlePush" @sync="() => doPull(pullMode === 'rebase')" />

            <!-- Changes view: conflict editor, file history, or diff viewer -->
            <template v-else-if="viewMode === 'changes'">
              <MergeEditor v-if="showingMergeEditor && mergeSelectedFile" :file="mergeSelectedFile"
                @resolve="handleResolveFile" @resolve-hunk="(path, idx, choice) => handleResolveHunk(path, idx, choice)"
                @resolve-hunk-custom="(path, idx, content) => handleResolveHunkCustom(path, idx, content)" />
              <FileHistoryViewer v-else-if="fileHistoryPath && repoFolderPath" :file-path="fileHistoryPath"
                :cwd="repoFolderPath" @close="closeFileHistory"
                @select-commit="(hash) => { closeFileHistory(); selectCommit(hash); viewMode = 'history'; }" />
              <!--
              Image files (PNG, JPEG, WebP, GIF, SVG) get the ImageDiffViewer
              branch; the line-based DiffViewer would hit its "binary file"
              dead-end and show nothing useful.
              - oldRev is always HEAD (what the file looked like before this change)
              - newRev is ":0" (the staged index version) when viewing staged
                changes, otherwise "" (the working tree on disk).
            -->
              <ImageDiffViewer v-else-if="isImagePath(repoSelectedFile) && repoFolderPath && repoSelectedFile"
                :cwd="repoFolderPath" :file-path="repoSelectedFile" old-rev="HEAD"
                :new-rev="repoSelectedFileStaged ? ':0' : ''" status="modified" />
              <DiffViewer v-else :diff="repoDiff" :file-path="repoSelectedFile" :diff-mode="diffMode" :selectable="true"
                @update:diff-mode="onDiffModeChange" @open-file-history="openFileHistory"
                @open-in-editor="handleOpenInEditor" @stage-patch="stagePatch"
                @select-dir-file="(path) => repoSelectFile(path, false)" />
            </template>

            <!-- History view: commit diff (log is in sidebar) -->
            <CommitDiffViewer v-else-if="viewMode === 'history'" :diffs="commitDiffs" :commit-hash="selectedCommitHash"
              :commit-info="repoLog.find(e => e.hashFull === selectedCommitHash) ?? null" :diff-mode="diffMode"
              @update:diff-mode="onDiffModeChange" />

            <!-- Graph view: DAG visualization -->
            <CommitGraph v-else-if="viewMode === 'graph'" :commits="repoLog" :selected-hash="selectedCommitHash"
              :current-branch="branchDisplay"
              :fork-point-sha="graphForkPointSha"
              @select-commit="(hash) => { selectCommit(hash); viewMode = 'history'; }" />

            <!-- PRs view: creation form takes over when showCreateForm is true -->
            <PrCreateView v-else-if="viewMode === 'prs' && prPanel.showCreateForm.value"
              :current-branch="repoStatus?.branch ?? ''" :branches="branches" :cwd="repoFolderPath ?? ''" />

            <!-- PRs view: detail panel fills the main area -->
            <PrDetailView v-else-if="viewMode === 'prs'" @refresh="repoRefresh"
              @navigate-commit="(hash) => { selectCommit(hash); viewMode = 'history'; }" />

            <!-- Launchpad view: cross-repo dashboard (v2.10 nav revamp) -->
            <LaunchpadView v-else-if="viewMode === 'launchpad'" :repos="launchpadRepos" />
          </template>
        </template>
      </main>
    </div>

    <!-- In-app update modal -->
    <UpdateModal v-if="pendingUpdate" ref="updateModalRef" :update="pendingUpdate" @close="pendingUpdate = null"
      @install="onInstallUpdate" />

    <!-- Folder picker modal (browser mode) -->
    <FolderPicker v-if="showFolderPicker" @select="onFolderSelected" @cancel="onFolderPickerCancel" />

    <!-- Edit commit overlay -->
    <EditCommitOverlay :entry="editingCommit" @confirm="handleAmendConfirm" @cancel="editingCommit = null" />

    <!-- Plain rebase-in-progress modal (pull --rebase paused on conflicts) -->
    <RebaseProgressModal v-if="showRebaseBanner && repoOperationState" :repo-state="repoOperationState"
      :cwd="repoFolderPath ?? ''" @action-done="onRebaseBannerActionDone" @error="(msg) => { repoError = msg; }" />

    <!-- Merge success modal -->
    <MergeSuccessModal v-if="showMergeSuccess" :merged-branch="lastMergedBranch ?? undefined"
      @close="onMergeSuccessClose" @push="onMergeSuccessPush" @delete-branch="onMergeSuccessDeleteBranch" />

    <!-- Split commit modal (driven by the useSplitCommit composable's
         module-level state — mounting once here is sufficient) -->
    <SplitCommitModal @split-completed="handleSplitCompleted" @close="handleSplitClose" />

    <!-- Success toast -->
    <div v-if="successToast" class="toast" :class="{ 'toast--leaving': successToastLeaving }" role="status">
      <div class="toast-body">
        <div class="toast-title">{{ successToast }}</div>
        <div class="toast-detail" v-if="successToastDetail">{{ successToastDetail }}</div>
      </div>
      <button class="toast-dismiss" @click="dismissToast">OK</button>
    </div>

    <!-- Interactive rebase panel -->
    <RebaseEditor v-if="showRebase && repoFolderPath" :cwd="repoFolderPath" :current-branch="branchDisplay"
      :branches="branches" @close="showRebase = false" @done="handleRebaseDone" />

    <!-- Stash manager (uses BaseModal, owns its own overlay) -->
    <StashManager v-if="showStash && repoFolderPath" :cwd="repoFolderPath" @close="showStash = false"
      @refresh="repoRefresh()" />

    <!-- Integrated git terminal (v2.0) — reuses the stash-overlay shell
         so it lives in the same overlay layer as worktrees / submodules. -->
    <div v-if="showTerminal && repoFolderPath" class="stash-overlay overlay-backdrop"
      @click.self="showTerminal = false">
      <div class="stash-overlay-body">
        <GitTerminal :cwd="repoFolderPath" @close="showTerminal = false" @refresh="repoRefresh()" />
      </div>
    </div>

    <!-- Clone modal (v2.0) -->
    <CloneModal v-if="showCloneModal" @close="showCloneModal = false" @cloned="onCloned" />

    <!-- Fork modal (v2.0) -->
    <ForkModal v-if="showForkModal" @close="showForkModal = false" @forked="onForked" />

    <!-- Workspace panel -->
    <WorkspacePanel v-if="showWorkspace" @close="showWorkspace = false"
      @open-tab="(path) => { openTab(path); showWorkspace = false; }" />

    <!-- Agent Sessions panel -->
    <AgentSessionsPanel v-if="showAgents && repoFolderPath" :cwd="repoFolderPath" @close="showAgents = false"
      @open-tab="(path) => { openTab(path); showAgents = false; }" />

    <!-- Command Log panel (⌘⇧L) — transparent git command audit trail (v2.11) -->
    <CommandLogPanel :visible="showCommandLog" @close="showCommandLog = false" />

    <!-- Tags panel -->
    <TagsPanel v-if="showTags && repoFolderPath" :cwd="repoFolderPath" @close="showTags = false"
      @create-tag="showTags = false; commitActionModal.type = 'tag'; commitActionModal.entry = repoLog[0] ?? null;" />

    <!-- Worktree manager (uses BaseModal internally → own Teleport + backdrop) -->
    <WorktreeManager v-if="showWorktrees && repoFolderPath" :cwd="repoFolderPath" :branches="branches"
      :suggested-branch="pendingWorktreeBranch" :open-quick-create="pendingQuickCreate"
      @close="showWorktrees = false; pendingWorktreeBranch = undefined; pendingQuickCreate = false;"
      @open-tab="(path) => { openTab(path); showWorktrees = false; pendingWorktreeBranch = undefined; pendingQuickCreate = false; }" />

    <!-- Submodule panel (uses BaseModal internally → own Teleport + backdrop) -->
    <SubmodulePanel v-if="showSubmodules && repoFolderPath" :cwd="repoFolderPath" @close="showSubmodules = false"
      @open-tab="(path) => { openTab(path); showSubmodules = false; }" />

    <!-- Push + unpushed tags confirmation modal -->
    <BaseModal v-if="pushTagsConfirm" :title="t('push.tagsConfirm.title')" size="sm" role="alertdialog"
      @close="pushTagsConfirm = false">
      <template #title-icon>
        <div class="ptc-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path
              d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </div>
      </template>

      <p class="ptc-desc">{{ t('push.tagsConfirm.desc', pendingUnpushedTags.length) }}</p>
      <ul class="ptc-tag-list">
        <li v-for="tag in pendingUnpushedTags.slice(0, 8)" :key="tag" class="ptc-tag">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 2h6l6 6-6 6-6-6V2z" />
            <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
          </svg>
          {{ tag }}
        </li>
        <li v-if="pendingUnpushedTags.length > 8" class="ptc-tag ptc-tag--more">
          +{{ pendingUnpushedTags.length - 8 }} {{ t('push.tagsConfirm.more') }}
        </li>
      </ul>

      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="pushTagsConfirm = false">{{ t('common.cancel') }}</button>
        <button class="bm-btn bm-btn--ghost" @click="confirmPushWithoutTags">{{ t('push.tagsConfirm.withoutTags')
          }}</button>
        <button class="bm-btn bm-btn--primary" @click="confirmPushWithTags">{{ t('push.tagsConfirm.withTags')
          }}</button>
      </template>
    </BaseModal>

    <!-- Stash-and-switch modal (asks for a stash label before switching branches) -->
    <div v-if="pendingSwitchBranch" class="switch-stash-overlay overlay-backdrop" @click.self="cancelSwitchStash">
      <div class="switch-stash-modal" role="dialog" aria-modal="true">
        <h3 class="switch-stash-title">
          {{ t('branches.switchStashTitle') }}
        </h3>
        <p class="switch-stash-desc">
          {{ t('branches.switchStashHint', pendingSwitchBranch) }}
        </p>
        <div class="switch-stash-row">
          <input v-model="switchStashMessage" type="text" class="switch-stash-input"
            :placeholder="t('branches.switchStashPlaceholder')" maxlength="120"
            @keydown.enter.prevent="confirmSwitchStash" @keydown.esc.prevent="cancelSwitchStash" />
          <button v-if="aiProvider.isAvailable.value" type="button" class="switch-stash-ai-btn"
            :disabled="isGeneratingSwitchStashMessage" @click="suggestSwitchStashMessage">
            <span v-if="isGeneratingSwitchStashMessage">…</span>
            <span v-else class="switch-stash-ai-label">
              <AiSparkle :size="13" />
              {{ t('common.ai') }}
            </span>
          </button>
        </div>
        <p v-if="switchStashAiError" class="switch-stash-error">{{ switchStashAiError }}</p>
        <div class="switch-stash-actions">
          <button type="button" class="switch-stash-cancel" @click="cancelSwitchStash">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="switch-stash-confirm" @click="confirmSwitchStash">
            {{ t('branches.switchStashConfirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Help panel -->
    <HelpView v-if="showHelp" @close="showHelp = false" />

    <!-- Settings panel -->
    <SettingsPanel v-if="showSettings" :error-log="logEntries" :initial-tab="settingsInitialTab"
      :cwd="repoFolderPath ?? undefined" @close="onSettingsClose" @update:commit-signature="onCommitSignatureChange"
      @update:diff-mode="onDiffModeChange" @update:pull-mode="onPullModeChange" @update:font-size="onFontSizeChange"
      @update:tab-size="onTabSizeChange" @clear-logs="clearErrorLog"
      @open-update-modal="(info) => { pendingUpdate = info }" />

    <!-- Command palette (Cmd/Ctrl+K) — teleports to body, so position
         in the template tree is cosmetic. Mounted conditionally so the
         input gets fresh autofocus each time it opens. -->
    <SearchPalette v-if="showSearchPalette" :branches="branches" :commits="repoLog" :actions="paletteActions"
      @close="showSearchPalette = false" @switch-branch="onPaletteSwitchBranch" @select-commit="onPaletteSelectCommit"
      @run-action="onPaletteAction" />

    <!-- Rename / Delete-branch modals, raised from BranchMenu.
         Both teleport to body and guard against `branchDisplay` going
         null between open + confirm (the :current-branch / :branch-name
         binding is non-null because we only mount when showing). -->
    <BranchRenameModal v-if="showBranchRenameModal && branchDisplay" :current-branch="branchDisplay"
      @close="showBranchRenameModal = false" @confirm="onBranchRenameConfirm" />
    <BranchDeleteModal v-if="showBranchDeleteModal && branchDisplay" :branch-name="branchDisplay"
      @close="showBranchDeleteModal = false" @confirm="onBranchDeleteConfirm" />

    <!-- ── Commit context-menu modals (v1.9) — using BaseModal for design consistency ── -->

    <!-- Checkout commit -->
    <BaseModal v-if="commitActionModal.type === 'checkout'" :title="t('commitCtx.checkout')"
      :subtitle="t('commitCtx.checkoutDesc', commitActionModal.entry?.hash ?? '')" size="sm" role="alertdialog"
      @close="closeCommitActionModal">
      <p class="cam-warn">{{ t('commitCtx.checkoutWarn') }}</p>
      <p v-if="commitActionModal.error" class="cam-error">{{ commitActionModal.error }}</p>
      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="closeCommitActionModal">{{ t('common.cancel') }}</button>
        <button class="bm-btn bm-btn--primary" :disabled="commitActionModal.busy" @click="confirmCheckoutCommit">
          {{ commitActionModal.busy ? t('common.loading') : t('commitCtx.checkout') }}
        </button>
      </template>
    </BaseModal>

    <!-- Reset to commit -->
    <BaseModal v-if="commitActionModal.type === 'reset'" :title="t('commitCtx.reset')"
      :subtitle="t('commitCtx.resetDesc', commitActionModal.entry?.hash ?? '')" size="sm" role="alertdialog"
      @close="closeCommitActionModal">
      <div class="cam-radio-group">
        <label v-for="mode in (['soft', 'mixed', 'hard'] as const)" :key="mode" class="cam-radio">
          <input type="radio" name="resetMode" :value="mode" v-model="commitActionModal.resetMode" />
          <span class="cam-radio-label">
            <strong>--{{ mode }}</strong>
            <span class="cam-radio-hint">{{ t((`commitCtx.reset${mode.charAt(0).toUpperCase() + mode.slice(1)}Hint`) as
              any)
              }}</span>
          </span>
        </label>
      </div>
      <p v-if="commitActionModal.resetMode === 'hard'" class="cam-warn" style="margin-top: var(--space-3)">{{
        t('commitCtx.resetHardWarn') }}</p>
      <p v-if="commitActionModal.error" class="cam-error">{{ commitActionModal.error }}</p>
      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="closeCommitActionModal">{{ t('common.cancel') }}</button>
        <button class="bm-btn" :class="commitActionModal.resetMode === 'hard' ? 'bm-btn--danger' : 'bm-btn--primary'"
          :disabled="commitActionModal.busy" @click="confirmResetToCommit">
          {{ commitActionModal.busy ? t('common.loading') : t('commitCtx.resetConfirm') }}
        </button>
      </template>
    </BaseModal>

    <!-- Create branch from commit -->
    <BaseModal v-if="commitActionModal.type === 'createBranch'" :title="t('commitCtx.createBranch')"
      :subtitle="t('commitCtx.createBranchDesc', commitActionModal.entry?.hash ?? '')" size="sm"
      @close="closeCommitActionModal">
      <input v-model="commitActionModal.branchName" type="text" class="cam-input"
        :placeholder="t('commitCtx.branchNamePlaceholder')" maxlength="100" autofocus
        @keydown.enter.prevent="confirmCreateBranchFromCommit" />
      <p v-if="commitActionModal.error" class="cam-error">{{ commitActionModal.error }}</p>
      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="closeCommitActionModal">{{ t('common.cancel') }}</button>
        <button class="bm-btn bm-btn--primary"
          :disabled="commitActionModal.busy || !commitActionModal.branchName.trim()"
          @click="confirmCreateBranchFromCommit">
          {{ commitActionModal.busy ? t('common.loading') : t('commitCtx.createBranchConfirm') }}
        </button>
      </template>
    </BaseModal>

    <!-- Tag this commit -->
    <BaseModal v-if="commitActionModal.type === 'tag'" :title="t('commitCtx.tag')"
      :subtitle="t('commitCtx.tagDesc', commitActionModal.entry?.hash ?? '')" size="sm" @close="closeCommitActionModal">
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <!-- AI suggestion strip -->
        <div v-if="isAIAvailable" class="tag-ai-row">
          <span class="tag-ai-hint">{{ t('commitCtx.tagAiHint') }}</span>
          <button class="bm-btn btn--ai tag-ai-btn" :disabled="commitActionModal.busy || isTagAISuggesting"
            @click="suggestTagWithAI">
            <AiSparkle :size="13" :animated="isTagAISuggesting" />
            {{ isTagAISuggesting ? t('common.loading') : t('commitCtx.tagAiSuggest') }}
          </button>
        </div>
        <input v-model="commitActionModal.tagName" type="text" class="cam-input"
          :placeholder="t('commitCtx.tagNamePlaceholder')" maxlength="100" autofocus />
        <input v-model="commitActionModal.tagMessage" type="text" class="cam-input"
          :placeholder="t('commitCtx.tagMessagePlaceholder')" maxlength="200"
          @keydown.enter.prevent="confirmTagCommit" />
        <p class="cam-hint">{{ t('commitCtx.tagAnnotatedHint') }}</p>
        <p v-if="commitActionModal.error" class="cam-error">{{ commitActionModal.error }}</p>
      </div>
      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="closeCommitActionModal">{{ t('common.cancel') }}</button>
        <button class="bm-btn bm-btn--primary" :disabled="commitActionModal.busy || !commitActionModal.tagName.trim()"
          @click="confirmTagCommit">
          {{ commitActionModal.busy ? t('common.loading') : t('commitCtx.tagConfirm') }}
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  border-right: 1px solid var(--color-border);
  overflow-y: auto;
  background: var(--color-bg-secondary);
}

.main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: var(--color-overlay);
  z-index: 10;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-text {
  font-size: 14px;
  color: var(--color-text-muted);
}

.error-toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-5);
  background: var(--color-danger-bg, rgba(243, 139, 168, .12));
  border-bottom: 1px solid var(--color-danger, #f38ba8);
  color: var(--color-danger, #f38ba8);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}

.error-toast-icon {
  flex-shrink: 0;
}

.error-toast-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error-toast-logs {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--color-danger, #f38ba8);
  font-size: var(--font-size-sm);
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
  opacity: 0.8;
}

.error-toast-logs:hover {
  opacity: 1;
}

.error-toast-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  background: none;
  border: none;
  color: var(--color-danger, #f38ba8);
  opacity: 0.6;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.error-toast-close:hover {
  opacity: 1;
}

/* slide-down enter/leave for Transition */
.error-toast-enter-active,
.error-toast-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  max-height: 60px;
  overflow: hidden;
}

.error-toast-enter-from,
.error-toast-leave-to {
  max-height: 0;
  opacity: 0;
}

/* ─── Merge conflict banner ──────────────────────────── */
.conflict-banner {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  background: var(--color-warning-bg);
  border-left: 3px solid var(--color-warning);
  color: var(--color-warning);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  flex-shrink: 0;
}

.conflict-text {
  flex: 1;
}

.conflict-abort-btn {
  padding: var(--space-2) var(--space-5);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.conflict-abort-btn:hover {
  background: var(--color-border);
}

/* ─── Toast ──────────────────────────────────────────── */
.toast {
  position: fixed;
  bottom: var(--space-8);
  right: var(--space-8);
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-5) var(--space-6);
  background: var(--color-surface-inverse);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  color: var(--color-surface-inverse-text);
  z-index: 200;
  min-width: 260px;
  max-width: 380px;
  animation: toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast--leaving {
  animation: toastSlideOut 0.2s ease-in forwards;
}

.toast-body {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-snug);
}

.toast-detail {
  font-size: var(--font-size-sm);
  color: var(--color-surface-inverse-muted);
  margin-top: var(--space-1);
}

.toast-dismiss {
  flex-shrink: 0;
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  background: var(--color-surface-inverse-action);
  color: var(--color-surface-inverse-text);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.toast-dismiss:hover {
  background: var(--color-surface-inverse-action-hover);
}

@keyframes toastSlideIn {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes toastSlideOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  to {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
}

/* ─── Stash overlay (Phase 1.3.3) ────────────────────────── */

.stash-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  padding: 32px;
  /* backdrop tint + blur come from the global .overlay-backdrop class */
}

.stash-overlay-body {
  width: min(640px, 100%);
  max-height: 80vh;
  display: flex;
}

/* ─── Stash-and-switch modal (Phase 1.3.3) ──────────────── */

.switch-stash-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 45;
  padding: 24px;
  /* backdrop tint + blur come from the global .overlay-backdrop class */
}

/* ─── Push-tags confirmation modal ──────────────────────── */
.ptc-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}

.ptc-desc {
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-md);
  color: var(--color-text);
  line-height: var(--line-height-snug);
}

.ptc-tag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ptc-tag {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}

.ptc-tag--more {
  font-family: inherit;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
}

.switch-stash-modal {
  width: min(520px, 100%);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 12px 40px rgba(0, 0, 0, 0.35));
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.switch-stash-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.switch-stash-desc {
  margin: 0;
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  line-height: 1.5;
}

.switch-stash-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.switch-stash-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-md);
  outline: none;
}

.switch-stash-input:focus {
  border-color: var(--color-accent);
}

.switch-stash-ai-btn {
  padding: 6px 12px;
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.1));
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  color: var(--color-accent);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.switch-stash-ai-btn:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-accent-text);
}

.switch-stash-ai-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch-stash-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.switch-stash-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-danger, #ef4444);
}

.switch-stash-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.switch-stash-cancel,
.switch-stash-confirm {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}

.switch-stash-cancel {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text);
}

.switch-stash-cancel:hover {
  background: var(--color-bg-hover);
}

.switch-stash-confirm {
  background: var(--color-accent);
  border: 1px solid var(--color-accent);
  color: var(--color-accent-text);
}

.switch-stash-confirm:hover {
  filter: brightness(1.08);
}

/* ── Commit action modal body elements (v1.9) ─────────── */
.tag-ai-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-accent-soft, rgba(124, 58, 237, 0.08));
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-accent-muted, rgba(124, 58, 237, 0.2));
}

.tag-ai-hint {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  flex: 1;
}

.tag-ai-btn {
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-3);
  gap: var(--space-1);
  flex-shrink: 0;
}

.cam-warn {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--color-warning);
}

.cam-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-danger, #ef4444);
}

.cam-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.cam-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  outline: none;
  box-sizing: border-box;
}

.cam-input:focus {
  border-color: var(--color-accent);
}

.cam-radio-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cam-radio {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  cursor: pointer;
}

.cam-radio-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cam-radio-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
</style>
