<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import AppHeader from "./components/AppHeader.vue";
import FileList from "./components/FileList.vue";
import MergeEditor from "./components/MergeEditor.vue";
import EmptyState from "./components/EmptyState.vue";
import FolderPicker from "./components/FolderPicker.vue";
import { useGitWand } from "./composables/useGitWand";
import { useTheme } from "./composables/useTheme";
import { isTauri, registerBrowserFolderPicker } from "./utils/backend";

const { theme, toggle: toggleTheme } = useTheme();

const {
  files,
  selectedFile,
  stats,
  loading,
  error,
  canUndo,
  canRedo,
  openFolder,
  resolveAll,
  resolveFile,
  resolveHunkManual,
  resolveHunkCustom,
  saveFile,
  undo,
  redo,
  selectFile,
} = useGitWand();

const hasFiles = computed(() => files.value.length > 0);

// Auto-dismiss error after 3s
let errorTimer: ReturnType<typeof setTimeout> | null = null;
watch(error, (val) => {
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  if (val) {
    errorTimer = setTimeout(() => { error.value = null; }, 3000);
  }
});

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
  if (showFolderPicker.value) return; // Let FolderPicker handle its own keys
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "k") {
    e.preventDefault();
    openFolder();
  } else if (mod && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (mod && e.key === "z" && e.shiftKey) {
    e.preventDefault();
    redo();
  } else if (mod && e.key === "y") {
    e.preventDefault();
    redo();
  }
}

onMounted(() => window.addEventListener("keydown", onKeyDown));
onUnmounted(() => window.removeEventListener("keydown", onKeyDown));
</script>

<template>
  <div class="app">
    <AppHeader
      :stats="stats"
      :has-files="hasFiles"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :theme="theme"
      @open-folder="openFolder"
      @resolve-all="resolveAll"
      @undo="undo"
      @redo="redo"
      @toggle-theme="toggleTheme"
    />

    <div class="app-body">
      <aside class="sidebar" v-if="hasFiles">
        <FileList
          :files="files"
          :selected-file="selectedFile"
          @select="selectFile"
        />
      </aside>

      <main class="main">
        <!-- Loading overlay -->
        <div v-if="loading" class="loading-overlay">
          <div class="loading-spinner"></div>
          <span class="loading-text">Analyse des conflits...</span>
        </div>

        <!-- Error banner -->
        <div v-if="error" class="error-banner" role="alert">
          <svg class="error-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.5"/>
            <path d="M9 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="9" cy="12" r="1" fill="currentColor"/>
          </svg>
          <span class="error-text">{{ error }}</span>
          <button class="error-close" @click="error = null" aria-label="Fermer">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M3.646 3.646a.5.5 0 01.708 0L7 6.293l2.646-2.647a.5.5 0 01.708.708L7.707 7l2.647 2.646a.5.5 0 01-.708.708L7 7.707l-2.646 2.647a.5.5 0 01-.708-.708L6.293 7 3.646 4.354a.5.5 0 010-.708z"/>
            </svg>
          </button>
        </div>

        <MergeEditor
          v-if="selectedFile"
          :file="selectedFile"
          @resolve="resolveFile"
          @resolve-hunk="(path, idx, choice) => resolveHunkManual(path, idx, choice)"
          @resolve-hunk-custom="(path, idx, content) => resolveHunkCustom(path, idx, content)"
        />
        <EmptyState v-else-if="!loading" @open-folder="openFolder" />
      </main>
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
