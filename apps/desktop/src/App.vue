<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import AppHeader from "./components/AppHeader.vue";
import FileList from "./components/FileList.vue";
import MergeEditor from "./components/MergeEditor.vue";
import EmptyState from "./components/EmptyState.vue";
import { useGitWand } from "./composables/useGitWand";

const {
  files,
  selectedFile,
  stats,
  canUndo,
  canRedo,
  openFolder,
  resolveAll,
  resolveFile,
  resolveHunkManual,
  resolveHunkCustom,
  undo,
  redo,
  selectFile,
} = useGitWand();

const hasFiles = computed(() => files.value.length > 0);

// ─── Keyboard shortcuts ──────────────────────────────────
function onKeyDown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "z" && !e.shiftKey) {
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
      @open-folder="openFolder"
      @resolve-all="resolveAll"
      @undo="undo"
      @redo="redo"
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
        <MergeEditor
          v-if="selectedFile"
          :file="selectedFile"
          @resolve="resolveFile"
          @resolve-hunk="(path, idx, choice) => resolveHunkManual(path, idx, choice)"
          @resolve-hunk-custom="(path, idx, content) => resolveHunkCustom(path, idx, content)"
        />
        <EmptyState v-else @open-folder="openFolder" />
      </main>
    </div>
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
}
</style>
