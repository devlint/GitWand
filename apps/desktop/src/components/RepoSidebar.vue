<script setup lang="ts">
import { computed } from "vue";
import type { RepoFileEntry, ViewMode } from "../composables/useGitRepo";

const props = defineProps<{
  files: RepoFileEntry[];
  selectedFile: string | null;
  viewMode: ViewMode;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number };
}>();

const emit = defineEmits<{
  select: [path: string, staged: boolean];
  changeView: [mode: ViewMode];
}>();

const sections = computed(() => {
  const map: Record<string, RepoFileEntry[]> = {
    conflicted: [],
    staged: [],
    unstaged: [],
    untracked: [],
  };
  for (const f of props.files) {
    map[f.section].push(f);
  }
  return map;
});

const sectionMeta: Record<string, { label: string; color: string; icon: string }> = {
  conflicted: { label: "Conflits", color: "var(--color-danger)", icon: "!" },
  staged: { label: "Staged", color: "var(--color-success)", icon: "+" },
  unstaged: { label: "Modifi\u00e9s", color: "var(--color-warning)", icon: "~" },
  untracked: { label: "Non suivis", color: "var(--color-text-muted)", icon: "?" },
};

function statusBadge(status: string): string {
  const map: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
  return map[status] ?? "?";
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    added: "var(--color-success)",
    modified: "var(--color-warning)",
    deleted: "var(--color-danger)",
    renamed: "var(--color-accent)",
  };
  return map[status] ?? "var(--color-text-muted)";
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function fileDir(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
}

const totalChanges = computed(() => props.files.length);
</script>

<template>
  <nav class="repo-sidebar" aria-label="Fichiers modifi\u00e9s">
    <!-- View mode tabs -->
    <div class="view-tabs">
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'changes' }"
        @click="emit('changeView', 'changes')"
      >
        Changements
        <span class="tab-badge" v-if="totalChanges > 0">{{ totalChanges }}</span>
      </button>
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'history' }"
        @click="emit('changeView', 'history')"
      >
        Historique
      </button>
    </div>

    <!-- File sections -->
    <div class="sections" v-if="viewMode === 'changes'">
      <template v-for="sectionKey in ['conflicted', 'staged', 'unstaged', 'untracked']" :key="sectionKey">
        <div
          v-if="sections[sectionKey].length > 0"
          class="section"
        >
          <div class="section-header">
            <span class="section-icon" :style="{ color: sectionMeta[sectionKey].color }">
              {{ sectionMeta[sectionKey].icon }}
            </span>
            <span class="section-label">{{ sectionMeta[sectionKey].label }}</span>
            <span class="section-count">{{ sections[sectionKey].length }}</span>
          </div>

          <ul class="file-items" role="listbox">
            <li
              v-for="file in sections[sectionKey]"
              :key="`${file.section}-${file.path}`"
              class="file-item"
              :class="{ 'file-item--selected': selectedFile === file.path }"
              role="option"
              :aria-selected="selectedFile === file.path"
              tabindex="0"
              @click="emit('select', file.path, file.section === 'staged')"
              @keydown.enter="emit('select', file.path, file.section === 'staged')"
              @keydown.space.prevent="emit('select', file.path, file.section === 'staged')"
            >
              <span
                class="file-status-badge mono"
                :style="{ color: statusColor(file.status) }"
                :title="file.status"
              >
                {{ statusBadge(file.status) }}
              </span>
              <div class="file-info">
                <span class="file-name mono">{{ fileName(file.path) }}</span>
                <span class="file-dir muted" v-if="fileDir(file.path)">{{ fileDir(file.path) }}</span>
              </div>
            </li>
          </ul>
        </div>
      </template>

      <!-- Empty state -->
      <div class="empty-section" v-if="totalChanges === 0">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 12l2 2 4-4" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="12" cy="12" r="9" stroke="var(--color-success)" stroke-width="1.5" opacity="0.4"/>
        </svg>
        <span class="empty-text">Working tree clean</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.repo-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.view-tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.view-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
  background: none;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.view-tab:hover {
  color: var(--color-text);
}

.view-tab--active {
  color: var(--color-text);
  border-bottom-color: var(--color-accent);
}

.tab-badge {
  font-size: 10px;
  font-weight: 600;
  background: var(--color-accent);
  color: #fff;
  padding: 1px 5px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}

.sections {
  flex: 1;
  overflow-y: auto;
}

.section {
  border-bottom: 1px solid var(--color-border);
}

.section:last-child {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  background: var(--color-bg);
  position: sticky;
  top: 0;
  z-index: 1;
}

.section-icon {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  width: 16px;
  text-align: center;
}

.section-label {
  flex: 1;
}

.section-count {
  font-variant-numeric: tabular-nums;
  background: var(--color-bg-tertiary);
  padding: 1px 6px;
  border-radius: 8px;
}

.file-items {
  list-style: none;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px 6px 18px;
  cursor: pointer;
  transition: background 0.1s;
  border-left: 3px solid transparent;
}

.file-item:hover {
  background: var(--color-bg-tertiary);
}

.file-item--selected {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

.file-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.file-status-badge {
  font-size: 12px;
  font-weight: 700;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.file-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-dir {
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
}

.empty-text {
  font-size: 13px;
  color: var(--color-text-muted);
}
</style>
