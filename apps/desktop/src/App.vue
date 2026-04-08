<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import AppHeader from "./components/AppHeader.vue";
import MergeEditor from "./components/MergeEditor.vue";
import EmptyState from "./components/EmptyState.vue";
import FolderPicker from "./components/FolderPicker.vue";
import RepoSidebar from "./components/RepoSidebar.vue";
import DiffViewer from "./components/DiffViewer.vue";
import CommitDiffViewer from "./components/CommitDiffViewer.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import { useGitWand } from "./composables/useGitWand";
import { useGitRepo } from "./composables/useGitRepo";
import { useTheme } from "./composables/useTheme";
import { useI18n } from "./composables/useI18n";

const { t } = useI18n();
import { isTauri, registerBrowserFolderPicker, pickFolder } from "./utils/backend";

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

// ─── Repo mode (useGitRepo) ────────────────────────────
const {
  folderPath: repoFolderPath,
  status: repoStatus,
  selectedFilePath: repoSelectedFile,
  diff: repoDiff,
  log: repoLog,
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
  commitMessage,
  canCommit,
  isCommitting,
  canPush,
  canPull,
  aheadCount,
  behindCount,
  isPushing,
  isPulling,
  openRepo,
  refresh: repoRefresh,
  selectFile: repoSelectFile,
  loadLog,
  stageFiles,
  stageAll,
  unstageFiles,
  unstageAll,
  commit: doCommit,
  push: doPush,
  pull: doPull,
  mergeBranch: doMerge,
  abortMerge: doAbortMerge,
  discardFiles,
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

// ─── Computed state ─────────────────────────────────────
const hasFiles = computed(() => repoFiles.value.length > 0);

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

// Auto-dismiss success toast after 2.5s
const successToast = ref<string | null>(null);
let successTimer: number | null = null;

watch(repoSuccess, (val) => {
  if (!val) return;
  // Clear any previous toast
  if (successTimer != null) { window.clearTimeout(successTimer); successTimer = null; }
  const key = ({
    "already-up-to-date": "header.syncUpToDate",
    "sync-done": "header.syncDone",
    "push-done": "header.pushDone",
    "merge-done": "header.mergeDone",
    "merge-aborted": "header.mergeAborted",
  } as Record<string, string>)[val] || val;
  successToast.value = t(key as any);
  // Reset source immediately so we can trigger again
  repoSuccess.value = null;
  successTimer = window.setTimeout(() => {
    successToast.value = null;
    successTimer = null;
  }, 2500);
});

// ─── Conflict handling ──────────────────────────────────
// When a conflicted file is selected, load it in useGitWand for resolution
const showingMergeEditor = ref(false);

watch(isSelectedFileConflicted, async (isConflicted) => {
  if (isConflicted && repoFolderPath.value && repoSelectedFile.value) {
    // Load conflicted files via useGitWand
    await mergeOpenPath(repoFolderPath.value);
    // Select the specific conflicted file
    mergeSelectFile(repoSelectedFile.value!);
    showingMergeEditor.value = true;
  } else {
    showingMergeEditor.value = false;
  }
});

// ─── Folder opening ─────────────────────────────────────
async function handleOpenFolder() {
  const path = await pickFolder();
  if (path) {
    await openRepo(path);
    if (viewMode.value === "history") {
      await loadLog();
    }
  }
}

async function handleOpenPath(path: string) {
  await openRepo(path);
}

// When switching tabs, load data as needed
watch(viewMode, async (mode) => {
  if (mode === "history" && hasRepo.value) {
    await loadLog();
  }
});

// ─── Repo sidebar events ────────────────────────────────
function onRepoFileSelect(path: string, staged: boolean) {
  repoSelectFile(path, staged);
}

function onViewModeChange(mode: "changes" | "history") {
  viewMode.value = mode;
}

// ─── Settings panel ─────────────────────────────────────
const showSettings = ref(false);

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
  }
}

onMounted(() => window.addEventListener("keydown", onKeyDown));
onUnmounted(() => window.removeEventListener("keydown", onKeyDown));
</script>

<template>
  <div class="app">
    <AppHeader
      :has-files="hasFiles"
      :theme="theme"
      :branch-display="branchDisplay"
      :repo-stats="repoStats"
      :has-repo="hasRepo"
      :folder-name="folderName"
      :can-push="canPush"
      :can-pull="canPull"
      :ahead-count="aheadCount"
      :behind-count="behindCount"
      :is-pushing="isPushing"
      :is-pulling="isPulling"
      :branches="branches"
      :branches-loading="branchesLoading"
      :is-switching-branch="isSwitchingBranch"
      :is-merging="isMerging"
      @open-folder="handleOpenFolder"
      @toggle-theme="toggleTheme"
      @push="doPush"
      @pull="doPull"
      @merge-branch="doMerge"
      @open-settings="showSettings = true"
      @switch-branch="switchBranch"
      @create-branch="createBranch"
      @delete-branch="deleteBranch"
      @load-branches="loadBranches"
    />

    <div class="app-body">
      <aside class="sidebar" v-if="hasRepo">
        <RepoSidebar
          :files="repoFiles"
          :selected-file="repoSelectedFile"
          :view-mode="viewMode"
          :repo-stats="repoStats"
          :commit-message="commitMessage"
          :can-commit="canCommit"
          :is-committing="isCommitting"
          :log-entries="repoLog"
          :log-loading="repoLoading"
          :selected-commit-hash="selectedCommitHash"
          :ahead-count="aheadCount"
          @select="onRepoFileSelect"
          @change-view="onViewModeChange"
          @stage-file="(path) => stageFiles([path])"
          @unstage-file="(path) => unstageFiles([path])"
          @stage-all="stageAll"
          @unstage-all="unstageAll"
          @commit="doCommit"
          @update:commit-message="(val) => commitMessage = val"
          @select-commit="selectCommit"
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

          <!-- Changes view: conflict editor or diff viewer -->
          <template v-if="viewMode === 'changes'">
            <MergeEditor
              v-if="showingMergeEditor && mergeSelectedFile"
              :file="mergeSelectedFile"
              @resolve="resolveFile"
              @resolve-hunk="(path, idx, choice) => resolveHunkManual(path, idx, choice)"
              @resolve-hunk-custom="(path, idx, content) => resolveHunkCustom(path, idx, content)"
            />
            <DiffViewer
              v-else
              :diff="repoDiff"
              :file-path="repoSelectedFile"
            />
          </template>

          <!-- History view: commit diff (log is in sidebar) -->
          <CommitDiffViewer
            v-else-if="viewMode === 'history'"
            :diffs="commitDiffs"
            :commit-hash="selectedCommitHash"
          />
        </template>
      </main>
    </div>

    <!-- Folder picker modal (browser mode) -->
    <FolderPicker
      v-if="showFolderPicker"
      @select="onFolderSelected"
      @cancel="onFolderPickerCancel"
    />

    <!-- Success toast -->
    <div v-if="successToast" class="success-toast" role="status" :key="successToast">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
        <path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>{{ successToast }}</span>
    </div>

    <!-- Settings panel -->
    <SettingsPanel
      v-if="showSettings"
      @close="showSettings = false"
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
  border-radius: 4px;
  background: none;
  color: var(--color-danger);
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}
.error-close:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.15);
}

/* ─── Merge conflict banner ──────────────────────────── */
.conflict-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: var(--color-warning-bg, rgba(234, 179, 8, 0.1));
  border-left: 3px solid var(--color-warning);
  color: var(--color-warning);
  font-size: 13px;
  font-weight: 500;
  flex-shrink: 0;
}

.conflict-text {
  flex: 1;
}

.conflict-abort-btn {
  padding: 4px 12px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  cursor: pointer;
  transition: background 0.12s;
}

.conflict-abort-btn:hover {
  background: var(--color-border);
}

/* ─── Success toast ──────────────────────────────────── */
.success-toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-success);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  color: var(--color-success);
  font-size: 13px;
  font-weight: 500;
  z-index: 100;
  pointer-events: none;
  animation: toastIn 0.25s ease-out;
}

@keyframes toastIn {
  from { opacity: 0; transform: translateX(-50%) translateY(10px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
