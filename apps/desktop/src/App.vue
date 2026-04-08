<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import AppHeader from "./components/AppHeader.vue";
import FileList from "./components/FileList.vue";
import MergeEditor from "./components/MergeEditor.vue";
import EmptyState from "./components/EmptyState.vue";
import FolderPicker from "./components/FolderPicker.vue";
import RepoSidebar from "./components/RepoSidebar.vue";
import DiffViewer from "./components/DiffViewer.vue";
import CommitLog from "./components/CommitLog.vue";
import { useGitWand } from "./composables/useGitWand";
import { useGitRepo } from "./composables/useGitRepo";
import { useTheme } from "./composables/useTheme";
import { isTauri, registerBrowserFolderPicker, pickFolder } from "./utils/backend";

const { theme, toggle: toggleTheme } = useTheme();

// ─── App mode ───────────────────────────────────────────
// "merge" = original conflict resolution view
// "repo"  = new full git client view
type AppMode = "merge" | "repo";
const appMode = ref<AppMode>("repo");

// ─── Merge mode (useGitWand) ────────────────────────────
const {
  files: mergeFiles,
  selectedFile: mergeSelectedFile,
  stats: mergeStats,
  loading: mergeLoading,
  error: mergeError,
  canUndo,
  canRedo,
  folderPath: mergeFolderPath,
  openFolder: mergeOpenFolder,
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
  viewMode,
  hasRepo,
  branchDisplay,
  isClean,
  allFiles: repoFiles,
  repoStats,
  openRepo,
  refresh: repoRefresh,
  selectFile: repoSelectFile,
  loadLog,
} = useGitRepo();

// ─── Computed state ─────────────────────────────────────
const isRepoMode = computed(() => appMode.value === "repo");
const isMergeMode = computed(() => appMode.value === "merge");

const hasFiles = computed(() =>
  isMergeMode.value ? mergeFiles.value.length > 0 : repoFiles.value.length > 0,
);

const loading = computed(() =>
  isMergeMode.value ? mergeLoading.value : repoLoading.value,
);

const error = computed({
  get: () => (isMergeMode.value ? mergeError.value : repoError.value),
  set: (val) => {
    if (isMergeMode.value) mergeError.value = val;
    else repoError.value = val;
  },
});

const canSave = computed(() => isMergeMode.value && mergeFiles.value.length > 0 && !!mergeFolderPath.value);

const currentFolderPath = computed(() =>
  isMergeMode.value ? mergeFolderPath.value : repoFolderPath.value,
);

// Auto-dismiss error after 3s
let errorTimer: ReturnType<typeof setTimeout> | null = null;
watch(error, (val) => {
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  if (val) {
    errorTimer = setTimeout(() => { error.value = null; }, 3000);
  }
});

// ─── Folder opening ─────────────────────────────────────
async function handleOpenFolder() {
  if (isMergeMode.value) {
    await mergeOpenFolder();
  } else {
    const path = await pickFolder();
    if (path) {
      await openRepo(path);
      // Load log if switching to history tab
      if (viewMode.value === "history") {
        await loadLog();
      }
    }
  }
}

async function handleOpenPath(path: string) {
  if (isMergeMode.value) {
    await mergeOpenPath(path);
  } else {
    await openRepo(path);
  }
}

function handleSwitchMode(mode: AppMode) {
  appMode.value = mode;
}

// When switching to history tab, load log
watch(viewMode, async (mode) => {
  if (mode === "history" && hasRepo.value) {
    await loadLog();
  }
});

// ─── Repo sidebar events ────────────────────────────────
function onRepoFileSelect(path: string, staged: boolean) {
  repoSelectFile(path, staged);
}

function onViewModeChange(mode: "changes" | "merge" | "history") {
  if (mode === "merge") {
    // Switch to merge mode if user clicks merge tab
    appMode.value = "merge";
    return;
  }
  viewMode.value = mode;
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
  } else if (mod && e.key === "z" && !e.shiftKey && isMergeMode.value) {
    e.preventDefault();
    undo();
  } else if (mod && e.key === "z" && e.shiftKey && isMergeMode.value) {
    e.preventDefault();
    redo();
  } else if (mod && e.key === "y" && isMergeMode.value) {
    e.preventDefault();
    redo();
  } else if (mod && e.key === "s") {
    e.preventDefault();
    if (canSave.value) saveAllFiles();
  }
}

onMounted(() => window.addEventListener("keydown", onKeyDown));
onUnmounted(() => window.removeEventListener("keydown", onKeyDown));
</script>

<template>
  <div class="app">
    <AppHeader
      :stats="mergeStats"
      :has-files="hasFiles"
      :can-undo="isMergeMode && canUndo"
      :can-redo="isMergeMode && canRedo"
      :can-save="canSave"
      :theme="theme"
      :app-mode="appMode"
      :branch-display="branchDisplay"
      :repo-stats="repoStats"
      :has-repo="hasRepo"
      @open-folder="handleOpenFolder"
      @resolve-all="resolveAll"
      @save-all="saveAllFiles"
      @undo="undo"
      @redo="redo"
      @toggle-theme="toggleTheme"
      @switch-mode="handleSwitchMode"
    />

    <div class="app-body">
      <!-- ─── MERGE MODE ──────────────────────── -->
      <template v-if="isMergeMode">
        <aside class="sidebar" v-if="mergeFiles.length > 0">
          <FileList
            :files="mergeFiles"
            :selected-file="mergeSelectedFile"
            @select="mergeSelectFile"
          />
        </aside>

        <main class="main">
          <div v-if="mergeLoading" class="loading-overlay">
            <div class="loading-spinner"></div>
            <span class="loading-text">Analyse des conflits...</span>
          </div>

          <div v-if="mergeError" class="error-banner" role="alert">
            <svg class="error-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.5"/>
              <path d="M9 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="9" cy="12" r="1" fill="currentColor"/>
            </svg>
            <span class="error-text">{{ mergeError }}</span>
            <button class="error-close" @click="mergeError = null" aria-label="Fermer">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <path d="M3.646 3.646a.5.5 0 01.708 0L7 6.293l2.646-2.647a.5.5 0 01.708.708L7.707 7l2.647 2.646a.5.5 0 01-.708.708L7 7.707l-2.646 2.647a.5.5 0 01-.708-.708L6.293 7 3.646 4.354a.5.5 0 010-.708z"/>
              </svg>
            </button>
          </div>

          <MergeEditor
            v-if="mergeSelectedFile"
            :file="mergeSelectedFile"
            @resolve="resolveFile"
            @resolve-hunk="(path, idx, choice) => resolveHunkManual(path, idx, choice)"
            @resolve-hunk-custom="(path, idx, content) => resolveHunkCustom(path, idx, content)"
          />
          <EmptyState v-else-if="!mergeLoading" @open-folder="handleOpenFolder" @open-path="handleOpenPath" />
        </main>
      </template>

      <!-- ─── REPO MODE ───────────────────────── -->
      <template v-else>
        <aside class="sidebar">
          <RepoSidebar
            :files="repoFiles"
            :selected-file="repoSelectedFile"
            :view-mode="viewMode"
            :repo-stats="repoStats"
            @select="onRepoFileSelect"
            @change-view="onViewModeChange"
          />
        </aside>

        <main class="main">
          <div v-if="repoLoading" class="loading-overlay">
            <div class="loading-spinner"></div>
            <span class="loading-text">Chargement du repo...</span>
          </div>

          <div v-if="repoError" class="error-banner" role="alert">
            <svg class="error-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.5"/>
              <path d="M9 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="9" cy="12" r="1" fill="currentColor"/>
            </svg>
            <span class="error-text">{{ repoError }}</span>
            <button class="error-close" @click="repoError = null" aria-label="Fermer">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <path d="M3.646 3.646a.5.5 0 01.708 0L7 6.293l2.646-2.647a.5.5 0 01.708.708L7.707 7l2.647 2.646a.5.5 0 01-.708.708L7 7.707l-2.646 2.647a.5.5 0 01-.708-.708L6.293 7 3.646 4.354a.5.5 0 010-.708z"/>
              </svg>
            </button>
          </div>

          <!-- Changes view: diff viewer -->
          <template v-if="viewMode === 'changes'">
            <DiffViewer
              v-if="hasRepo"
              :diff="repoDiff"
              :file-path="repoSelectedFile"
            />
            <EmptyState v-else @open-folder="handleOpenFolder" @open-path="handleOpenPath" />
          </template>

          <!-- History view: commit log -->
          <template v-else-if="viewMode === 'history'">
            <CommitLog
              v-if="hasRepo"
              :entries="repoLog"
              :loading="repoLoading"
            />
            <EmptyState v-else @open-folder="handleOpenFolder" @open-path="handleOpenPath" />
          </template>
        </main>
      </template>
    </div>

    <!-- Folder picker modal (browser mode) -->
    <FolderPicker
      v-if="showFolderPicker"
      @select="onFolderSelected"
      @cancel="onFolderPickerCancel"
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
</style>
