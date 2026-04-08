<script setup lang="ts">
import { computed } from "vue";
import type { RepoFileEntry, ViewMode } from "../composables/useGitRepo";
import type { GitLogEntry } from "../utils/backend";
import CommitLog from "./CommitLog.vue";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{
  files: RepoFileEntry[];
  selectedFile: string | null;
  viewMode: ViewMode;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number };
  commitMessage: string;
  canCommit: boolean;
  isCommitting: boolean;
  // History mode props
  logEntries: GitLogEntry[];
  logLoading: boolean;
  selectedCommitHash: string | null;
  aheadCount: number;
}>();

const emit = defineEmits<{
  select: [path: string, staged: boolean];
  changeView: [mode: ViewMode];
  stageFile: [path: string];
  unstageFile: [path: string];
  stageAll: [];
  unstageAll: [];
  commit: [];
  "update:commitMessage": [value: string];
  selectCommit: [hash: string];
}>();

const { t } = useI18n();

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

const sectionMeta = computed((): Record<string, { label: string; color: string; icon: string }> => ({
  conflicted: { label: t('sidebar.sectionConflicts'), color: "var(--color-danger)", icon: "!" },
  staged: { label: t('sidebar.sectionStaged'), color: "var(--color-success)", icon: "+" },
  unstaged: { label: t('sidebar.sectionModified'), color: "var(--color-warning)", icon: "~" },
  untracked: { label: t('sidebar.sectionUntracked'), color: "var(--color-text-muted)", icon: "?" },
}));

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

function onStageClick(e: Event, path: string) {
  e.stopPropagation();
  emit("stageFile", path);
}

function onUnstageClick(e: Event, path: string) {
  e.stopPropagation();
  emit("unstageFile", path);
}

function onCommitMessageInput(e: Event) {
  emit("update:commitMessage", (e.target as HTMLTextAreaElement).value);
}

function onCommitKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (props.canCommit) emit("commit");
  }
}
</script>

<template>
  <nav class="repo-sidebar" :aria-label="t('sidebar.tabChanges')">
    <!-- View mode tabs -->
    <div class="view-tabs">
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'changes' }"
        @click="emit('changeView', 'changes')"
      >
        {{ t('sidebar.tabChanges') }}
        <span class="tab-badge" v-if="totalChanges > 0">{{ totalChanges }}</span>
      </button>
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'history' }"
        @click="emit('changeView', 'history')"
      >
        {{ t('sidebar.tabLog') }}
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
            <!-- Stage all / Unstage all buttons -->
            <button
              v-if="sectionKey === 'unstaged' || sectionKey === 'untracked'"
              class="section-action"
              @click="emit('stageAll')"
              :title="t('sidebar.stageAll')"
            >+</button>
            <button
              v-if="sectionKey === 'staged'"
              class="section-action"
              @click="emit('unstageAll')"
              :title="t('sidebar.unstageAll')"
            >-</button>
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
              <!-- Stage / Unstage per file -->
              <button
                v-if="file.section === 'unstaged' || file.section === 'untracked'"
                class="file-action"
                @click="onStageClick($event, file.path)"
                :title="t('sidebar.stage')"
              >+</button>
              <button
                v-if="file.section === 'staged'"
                class="file-action"
                @click="onUnstageClick($event, file.path)"
                :title="t('sidebar.unstage')"
              >-</button>
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
        <span class="empty-text">{{ t('sidebar.cleanTree') }}</span>
      </div>

      <!-- Commit panel -->
      <div class="commit-panel" v-if="repoStats.staged > 0 || commitMessage.length > 0">
        <textarea
          class="commit-input mono"
          :value="commitMessage"
          @input="onCommitMessageInput"
          @keydown="onCommitKeydown"
          :placeholder="t('sidebar.commitPlaceholder')"
          rows="3"
        ></textarea>
        <button
          class="commit-btn"
          :class="{ 'commit-btn--disabled': !canCommit }"
          :disabled="!canCommit"
          @click="emit('commit')"
        >
          <svg v-if="isCommitting" class="commit-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13.5 3.5l-7 7L3 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ isCommitting ? t('sidebar.commitButtonLoading') : t('sidebar.commitButton', repoStats.staged) }}</span>
        </button>
        <span class="commit-hint muted">{{ t('sidebar.commitHint') }}</span>
      </div>
    </div>

    <!-- History view: commit log in sidebar -->
    <div class="sidebar-log" v-if="viewMode === 'history'">
      <CommitLog
        :entries="logEntries"
        :loading="logLoading"
        :selected-hash="selectedCommitHash"
        :ahead-count="aheadCount"
        @select-commit="(hash: string) => emit('selectCommit', hash)"
      />
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
  display: flex;
  flex-direction: column;
}

.sidebar-log {
  flex: 1;
  overflow: hidden;
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

.section-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-muted);
  background: none;
  transition: background 0.1s, color 0.1s;
}

.section-action:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
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

.file-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity 0.1s, background 0.1s, color 0.1s;
  flex-shrink: 0;
}

.file-item:hover .file-action {
  opacity: 1;
}

.file-action:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
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

/* Commit panel */
.commit-panel {
  border-top: 1px solid var(--color-border);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--color-bg-secondary);
  flex-shrink: 0;
  margin-top: auto;
}

.commit-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  resize: vertical;
  min-height: 60px;
  max-height: 150px;
  outline: none;
  transition: border-color 0.15s;
}

.commit-input:focus {
  border-color: var(--color-accent);
}

.commit-input::placeholder {
  color: var(--color-text-muted);
}

.commit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  background: var(--color-accent);
  color: #fff;
  border-radius: 6px;
  transition: background 0.15s, opacity 0.15s;
}

.commit-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.commit-btn--disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.commit-spinner {
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.commit-hint {
  font-size: 10px;
  text-align: center;
}
</style>
