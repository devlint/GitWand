<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, provide } from "vue";
import AppHeader from "./components/AppHeader.vue";
import RepoTabBar from "./components/RepoTabBar.vue";
import MergeEditor from "./components/MergeEditor.vue";
import EmptyState from "./components/EmptyState.vue";
import FolderPicker from "./components/FolderPicker.vue";
import RepoSidebar from "./components/RepoSidebar.vue";
import DiffViewer from "./components/DiffViewer.vue";
import CommitDiffViewer from "./components/CommitDiffViewer.vue";
import FileHistoryViewer from "./components/FileHistoryViewer.vue";
import CommitGraph from "./components/CommitGraph.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import PrDetailView from "./components/PrDetailView.vue";
import PrCreateView from "./components/PrCreateView.vue";
import DashboardView from "./components/DashboardView.vue";
import EditCommitOverlay from "./components/EditCommitOverlay.vue";
import MergeSuccessModal from "./components/MergeSuccessModal.vue";
import RebaseEditor from "./components/RebaseEditor.vue";
import StashManager from "./components/StashManager.vue";
import { useStashMessage } from "./composables/useStashMessage";
import { useAIProvider } from "./composables/useAIProvider";
import { usePrPanel, PR_PANEL_KEY } from "./composables/usePrPanel";
import type { GitLogEntry } from "./utils/backend";
import { getPersistedDiffMode, persistDiffMode, type DiffMode } from "./utils/diffMode";
import { useGitWand } from "./composables/useGitWand";
import { useRepoTabs } from "./composables/useRepoTabs";
import { useGitRepo, type ViewMode } from "./composables/useGitRepo";
import { useTheme } from "./composables/useTheme";
import { useI18n } from "./composables/useI18n";
import { useSettings } from "./composables/useSettings";
import { gitStash, gitStashPop, openInEditor, setGitConfig, gitDiscard, gitAddToGitignore } from "./utils/backend";

const { t } = useI18n();
const { settings, refreshSettings } = useSettings();
import { isTauri, registerBrowserFolderPicker, pickFolder, checkForUpdates } from "./utils/backend";

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
} = useGitWand();

// ─── Repo mode (useGitRepo) — single shared instance ────
const {
  folderPath: repoFolderPath,
  status: repoStatus,
  selectedFilePath: repoSelectedFile,
  diff: repoDiff,
  log: repoLog,
  logScope,
  logAuthorFilter,
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
  isPushing,
  isPulling,
  openRepo,
  refresh: repoRefresh,
  selectFile: repoSelectFile,
  loadLog,
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
  mergeBranch: doMerge,
  mergeContinue: doMergeContinue,
  abortMerge: doAbortMerge,
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
} = useGitRepo();

// ─── PR panel (shared state via provide/inject) ──────────
const prCwd = computed(() => repoFolderPath.value ?? "");
const prPanel = usePrPanel(prCwd);
provide(PR_PANEL_KEY, prPanel);

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
watch(activeTabId, async () => {
  const tab = repoTabs.value.find((t) => t.id === activeTabId.value);
  if (tab && tab.path !== repoFolderPath.value) {
    await openRepo(tab.path);
    if (viewMode.value === "history" || viewMode.value === "graph") {
      await loadLog();
    }
  }
});

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
    errorTimer = setTimeout(() => { repoError.value = null; }, 3000);
  }
});

// ─── Merge success modal ──────────────────────────────────
const showMergeSuccess = ref(false);

function onMergeSuccessClose() {
  showMergeSuccess.value = false;
  viewMode.value = "dashboard";
}

async function onMergeSuccessPush() {
  showMergeSuccess.value = false;
  viewMode.value = "dashboard";
  await doPush();
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
    } else {
      // All conflicts resolved → finalize the merge commit, then show modal
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
    repoError.value = t("branches.switchRefusedDirty" as any) ||
      "Switch refusé : des changements non commités sont présents.";
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
    const msg = t("branches.switchConfirmDirty" as any) ||
      "Des changements non commités seront perdus. Continuer quand même ?";
    if (window.confirm(msg)) {
      await switchBranch(name);
    }
    return;
  }

  // Fallback
  await switchBranch(name);
}

// ─── Settings panel ─────────────────────────────────────
const showSettings = ref(false);

// ─── Interactive rebase panel ────────────────────────────
const showRebase = ref(false);

// ─── Stash manager panel ────────────────────────────────
const showStash = ref(false);

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
  if (e.key !== "Escape") return;
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
  if (mod && e.key === "k") {
    e.preventDefault();
    handleOpenFolder();
  } else if (mod && e.key === "t") {
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
}

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

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  applyGitConfig();
  setupGlobalShortcutListener();
  // Check for updates after a short delay so the app renders first.
  // The updater plugin shows a native OS dialog if a newer version is available.
  setTimeout(() => checkForUpdates(), 5_000);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
  unlistenGlobalShortcut?.();
});
</script>

<template>
  <div class="app">
    <RepoTabBar
      :tabs="repoTabs"
      :active-tab-id="activeTabId"
      @switch-tab="switchTab"
      @close-tab="closeTab"
      @new-tab="handleOpenFolder"
    />

    <AppHeader
      :has-files="hasFiles"
      :theme="theme"
      :branch-display="branchDisplay"
      :repo-stats="repoStats"
      :has-repo="hasRepo"
      :folder-name="folderName"
      :can-push="canPush"
      :can-pull="canPull"
      :needs-publish="needsPublish"
      :ahead-count="aheadCount"
      :behind-count="behindCount"
      :is-pushing="isPushing"
      :is-pulling="isPulling"
      :cwd="repoFolderPath ?? ''"
      :branches="branches"
      :branches-loading="branchesLoading"
      :is-switching-branch="isSwitchingBranch"
      :is-merging="isMerging"
      @open-folder="handleOpenFolder"
      @open-repo="handleOpenPath"
      @toggle-theme="toggleTheme"
      @push="doPush"
      @pull="() => doPull(pullMode === 'rebase')"
      @merge-branch="doMerge"
      @open-settings="showSettings = true"
      @switch-branch="handleSwitchBranch"
      @create-branch="createBranch"
      @delete-branch="deleteBranch"
      @load-branches="loadBranches"
      @undo-performed="repoRefresh()"
      @open-rebase="showRebase = true"
    />

    <div class="app-body">
      <aside class="sidebar" v-if="hasRepo">
        <RepoSidebar
          :cwd="repoFolderPath ?? ''"
          :files="repoFiles"
          :selected-file="repoSelectedFile"
          :view-mode="viewMode"
          :repo-stats="repoStats"
          :commit-summary="commitSummary"
          :commit-description="commitDescription"
          :can-commit="canCommit"
          :is-committing="isCommitting"
          :log-entries="repoLog"
          :log-loading="repoLoading"
          :log-scope="logScope"
          :log-author-filter="logAuthorFilter"
          :current-branch="repoStatus?.branch ?? ''"
          :selected-commit-hash="selectedCommitHash"
          :ahead-count="aheadCount"
          :needs-publish="needsPublish"
          :dir-files="expandedDirFiles"
          :branches="branches"
          @select="onRepoFileSelect"
          @change-view="onViewModeChange"
          @select-dir-file="(path) => repoSelectFile(path, false)"
          @stage-file="(path) => stageFiles([path])"
          @unstage-file="(path) => unstageFiles([path])"
          @stage-all="stageAll"
          @stage-paths="(paths) => stageFiles(paths)"
          @unstage-all="unstageAll"
          @commit="doCommit"
          @update:commit-summary="(val) => commitSummary = val"
          @update:commit-description="(val) => commitDescription = val"
          @select-commit="selectCommit"
          @edit-commit="handleEditCommit"
          @update:log-scope="setLogScope"
          @update:log-author-filter="setLogAuthorFilter"
          @discard="(path, section) => discardFiles([path], section === 'untracked')"
          @add-to-gitignore="(path) => addToGitignore(path)"
          @refresh="repoRefresh()"
          @open-stash="showStash = true"
        />
      </aside>

      <main class="main">
        <!-- No repo loaded → EmptyState full screen -->
        <EmptyState v-if="!hasRepo && !repoLoading" @open-folder="handleOpenFolder" @open-path="handleOpenPath" />

        <template v-else>
          <div v-if="repoLoading" class="loading-overlay">
            <div class="loading-spinner"></div>
            <span class="loading-text">{{ t('merge.loadingRepo') }}</span>
          </div>

          <template v-else>
          <div v-if="repoError" class="error-banner" role="alert">
            <svg class="error-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.5"/>
              <path d="M9 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="9" cy="12" r="1" fill="currentColor"/>
            </svg>
            <span class="error-text">{{ repoError }}</span>
            <button class="error-close" @click="repoError = null" :aria-label="t('common.close')">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <path d="M3.646 3.646a.5.5 0 01.708 0L7 6.293l2.646-2.647a.5.5 0 01.708.708L7.707 7l2.647 2.646a.5.5 0 01-.708.708L7 7.707l-2.646 2.647a.5.5 0 01-.708-.708L6.293 7 3.646 4.354a.5.5 0 010-.708z"/>
              </svg>
            </button>
          </div>

          <!-- Merge conflict banner -->
          <div v-if="hasConflicts" class="conflict-banner" role="alert">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M9 1.5L16.5 15H1.5L9 1.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M9 7v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="9" cy="12.5" r="0.75" fill="currentColor"/>
            </svg>
            <span class="conflict-text">
              {{ repoStats.conflicted }} {{ repoStats.conflicted > 1 ? t('header.conflicts') : t('header.conflict') }}
              — {{ t('header.resolveConflicts') }}
            </span>
            <button class="conflict-abort-btn" @click="doAbortMerge">
              {{ t('header.abortMerge') }}
            </button>
          </div>

          <!-- Dashboard view (default when opening a repo) -->
          <DashboardView
            v-if="viewMode === 'dashboard'"
            :cwd="repoFolderPath ?? ''"
            :branch="branchDisplay"
            :status="repoStats"
            :ahead="aheadCount"
            :behind="behindCount"
            :needs-publish="needsPublish"
            @change-view="onViewModeChange"
            @push="doPush"
            @sync="() => doPull(pullMode === 'rebase')"
          />

          <!-- Changes view: conflict editor, file history, or diff viewer -->
          <template v-else-if="viewMode === 'changes'">
            <MergeEditor
              v-if="showingMergeEditor && mergeSelectedFile"
              :file="mergeSelectedFile"
              @resolve="handleResolveFile"
              @resolve-hunk="(path, idx, choice) => handleResolveHunk(path, idx, choice)"
              @resolve-hunk-custom="(path, idx, content) => handleResolveHunkCustom(path, idx, content)"
            />
            <FileHistoryViewer
              v-else-if="fileHistoryPath && repoFolderPath"
              :file-path="fileHistoryPath"
              :cwd="repoFolderPath"
              @close="closeFileHistory"
              @select-commit="(hash) => { closeFileHistory(); selectCommit(hash); viewMode = 'history'; }"
            />
            <DiffViewer
              v-else
              :diff="repoDiff"
              :file-path="repoSelectedFile"
              :diff-mode="diffMode"
              :selectable="true"
              @update:diff-mode="onDiffModeChange"
              @open-file-history="openFileHistory"
              @open-in-editor="handleOpenInEditor"
              @stage-patch="stagePatch"
              @select-dir-file="(path) => repoSelectFile(path, false)"
            />
          </template>

          <!-- History view: commit diff (log is in sidebar) -->
          <CommitDiffViewer
            v-else-if="viewMode === 'history'"
            :diffs="commitDiffs"
            :commit-hash="selectedCommitHash"
            :commit-info="repoLog.find(e => e.hashFull === selectedCommitHash) ?? null"
            :diff-mode="diffMode"
            @update:diff-mode="onDiffModeChange"
          />

          <!-- Graph view: DAG visualization -->
          <CommitGraph
            v-else-if="viewMode === 'graph'"
            :commits="repoLog"
            :selected-hash="selectedCommitHash"
            :current-branch="branchDisplay"
            @select-commit="(hash) => { selectCommit(hash); viewMode = 'history'; }"
          />

          <!-- PRs view: creation form takes over when showCreateForm is true -->
          <PrCreateView
            v-else-if="viewMode === 'prs' && prPanel.showCreateForm.value"
            :current-branch="branchDisplay"
            :branches="branches"
            :cwd="repoFolderPath ?? ''"
          />

          <!-- PRs view: detail panel fills the main area -->
          <PrDetailView
            v-else-if="viewMode === 'prs'"
            @refresh="repoRefresh"
            @navigate-commit="(hash) => { selectCommit(hash); viewMode = 'history'; }"
          />
          </template>
        </template>
      </main>
    </div>

    <!-- Folder picker modal (browser mode) -->
    <FolderPicker
      v-if="showFolderPicker"
      @select="onFolderSelected"
      @cancel="onFolderPickerCancel"
    />

    <!-- Edit commit overlay -->
    <EditCommitOverlay
      :entry="editingCommit"
      @confirm="handleAmendConfirm"
      @cancel="editingCommit = null"
    />

    <!-- Merge success modal -->
    <MergeSuccessModal
      v-if="showMergeSuccess"
      @close="onMergeSuccessClose"
      @push="onMergeSuccessPush"
    />

    <!-- Success toast -->
    <div
      v-if="successToast"
      class="toast"
      :class="{ 'toast--leaving': successToastLeaving }"
      role="status"
    >
      <div class="toast-body">
        <div class="toast-title">{{ successToast }}</div>
        <div class="toast-detail" v-if="successToastDetail">{{ successToastDetail }}</div>
      </div>
      <button class="toast-dismiss" @click="dismissToast">OK</button>
    </div>

    <!-- Interactive rebase panel -->
    <RebaseEditor
      v-if="showRebase && repoFolderPath"
      :cwd="repoFolderPath"
      :current-branch="branchDisplay"
      :branches="branches"
      @close="showRebase = false"
      @done="handleRebaseDone"
    />

    <!-- Stash manager overlay -->
    <div v-if="showStash && repoFolderPath" class="stash-overlay overlay-backdrop" @click.self="showStash = false">
      <div class="stash-overlay-body">
        <StashManager
          :cwd="repoFolderPath"
          @close="showStash = false"
          @refresh="repoRefresh()"
        />
      </div>
    </div>

    <!-- Stash-and-switch modal (asks for a stash label before switching branches) -->
    <div v-if="pendingSwitchBranch" class="switch-stash-overlay overlay-backdrop" @click.self="cancelSwitchStash">
      <div class="switch-stash-modal" role="dialog" aria-modal="true">
        <h3 class="switch-stash-title">
          {{ uiLocale === 'fr' ? 'Stasher avant de changer de branche' : 'Stash before switching branch' }}
        </h3>
        <p class="switch-stash-desc">
          {{ uiLocale === 'fr'
            ? `Tes changements seront mis de côté, puis restaurés après le switch vers « ${pendingSwitchBranch} ». Donne-lui un label pour le retrouver.`
            : `Your changes will be stashed then restored after switching to "${pendingSwitchBranch}". Give it a label so you can find it.` }}
        </p>
        <div class="switch-stash-row">
          <input
            v-model="switchStashMessage"
            type="text"
            class="switch-stash-input"
            :placeholder="uiLocale === 'fr' ? 'Message optionnel (laisse vide pour le label par défaut)' : 'Optional message (empty = default label)'"
            maxlength="120"
            @keydown.enter.prevent="confirmSwitchStash"
            @keydown.esc.prevent="cancelSwitchStash"
          />
          <button
            v-if="aiProvider.isAvailable.value"
            type="button"
            class="switch-stash-ai-btn"
            :disabled="isGeneratingSwitchStashMessage"
            @click="suggestSwitchStashMessage"
          >
            <span v-if="isGeneratingSwitchStashMessage">…</span>
            <span v-else>✨ {{ uiLocale === 'fr' ? 'IA' : 'AI' }}</span>
          </button>
        </div>
        <p v-if="switchStashAiError" class="switch-stash-error">{{ switchStashAiError }}</p>
        <div class="switch-stash-actions">
          <button type="button" class="switch-stash-cancel" @click="cancelSwitchStash">
            {{ uiLocale === 'fr' ? 'Annuler' : 'Cancel' }}
          </button>
          <button type="button" class="switch-stash-confirm" @click="confirmSwitchStash">
            {{ uiLocale === 'fr' ? 'Stasher &amp; changer' : 'Stash &amp; switch' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Settings panel -->
    <SettingsPanel
      v-if="showSettings"
      @close="onSettingsClose"
      @update:commit-signature="onCommitSignatureChange"
      @update:diff-mode="onDiffModeChange"
      @update:pull-mode="onPullModeChange"
      @update:font-size="onFontSizeChange"
      @update:tab-size="onTabSizeChange"
    />
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
  to { transform: rotate(360deg); }
}

.loading-text {
  font-size: 14px;
  color: var(--color-text-muted);
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--color-danger-bg);
  border-left: 3px solid var(--color-danger);
  color: var(--color-danger);
  font-size: 13px;
  font-weight: 500;
  flex-shrink: 0;
  animation: slideDown 0.25s ease-out;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-100%); }
  to { opacity: 1; transform: translateY(0); }
}

.error-icon {
  flex-shrink: 0;
}

.error-text {
  flex: 1;
}

.error-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--color-danger);
  opacity: 0.6;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}
.error-close:hover {
  opacity: 1;
  background: var(--color-danger-bg);
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
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes toastSlideOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(8px) scale(0.96); }
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

.switch-stash-modal {
  width: min(520px, 100%);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.35));
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
</style>
