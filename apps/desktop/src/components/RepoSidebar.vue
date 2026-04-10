<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { type RepoFileEntry, type ViewMode } from "../composables/useGitRepo";
import type { GitLogEntry } from "../utils/backend";
import CommitLog from "./CommitLog.vue";
import PrListSidebar from "./PrListSidebar.vue";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{
  files: RepoFileEntry[];
  selectedFile: string | null;
  viewMode: ViewMode;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number };
  commitSummary: string;
  commitDescription: string;
  canCommit: boolean;
  isCommitting: boolean;
  // History mode props
  logEntries: GitLogEntry[];
  logLoading: boolean;
  selectedCommitHash: string | null;
  aheadCount: number;
  /** Files inside the currently-selected untracked directory */
  dirFiles?: string[];
}>();

const emit = defineEmits<{
  select: [path: string, staged: boolean];
  changeView: [mode: ViewMode];
  stageFile: [path: string];
  unstageFile: [path: string];
  stageAll: [];
  unstageAll: [];
  commit: [];
  "update:commitSummary": [value: string];
  "update:commitDescription": [value: string];
  selectCommit: [hash: string];
  editCommit: [entry: GitLogEntry];
  /** Select a specific file inside an expanded untracked directory */
  "select-dir-file": [path: string];
  /** Discard changes to a file (tracked: restore, untracked: delete) */
  discard: [path: string, section: string];
  /** Append file path to .gitignore */
  addToGitignore: [path: string];
}>();

const { t } = useI18n();

// ─── Context menu ─────────────────────────────────────────────
interface CtxMenu {
  visible: boolean;
  x: number;
  y: number;
  file: RepoFileEntry | null;
}
const ctxMenu = ref<CtxMenu>({ visible: false, x: 0, y: 0, file: null });

function openContextMenu(e: MouseEvent, file: RepoFileEntry) {
  e.preventDefault();
  e.stopPropagation();
  ctxMenu.value = { visible: true, x: e.clientX, y: e.clientY, file };
}

function closeContextMenu() {
  ctxMenu.value.visible = false;
}

function onCtxDiscard() {
  if (!ctxMenu.value.file) return;
  emit("discard", ctxMenu.value.file.path, ctxMenu.value.file.section);
  closeContextMenu();
}

function onCtxGitignore() {
  if (!ctxMenu.value.file) return;
  emit("addToGitignore", ctxMenu.value.file.path);
  closeContextMenu();
}

onMounted(() => {
  window.addEventListener("click", closeContextMenu);
  window.addEventListener("contextmenu", closeContextMenu);
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") closeContextMenu();
  });
});
onUnmounted(() => {
  window.removeEventListener("click", closeContextMenu);
  window.removeEventListener("contextmenu", closeContextMenu);
});

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

const unstagedCount = computed(() => props.repoStats.unstaged + props.repoStats.untracked);

function onStageClick(e: Event, path: string) {
  e.stopPropagation();
  emit("stageFile", path);
}

function onUnstageClick(e: Event, path: string) {
  e.stopPropagation();
  emit("unstageFile", path);
}

function onSummaryInput(e: Event) {
  emit("update:commitSummary", (e.target as HTMLInputElement).value);
}

function onDescriptionInput(e: Event) {
  emit("update:commitDescription", (e.target as HTMLTextAreaElement).value);
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
      <button
        class="view-tab"
        :class="{ 'view-tab--active': viewMode === 'graph' }"
        @click="emit('changeView', 'graph')"
      >
        {{ t('sidebar.tabGraph') }}
      </button>
      <button
        class="view-tab view-tab--pr"
        :class="{ 'view-tab--active': viewMode === 'prs' }"
        @click="emit('changeView', 'prs')"
        title="Pull Requests"
      >
        PRs
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
            <template
              v-for="file in sections[sectionKey]"
              :key="`${file.section}-${file.path}`"
            >
              <!-- Directory or regular file item -->
              <li
                class="file-item"
                :class="{ 'file-item--selected': selectedFile === file.path }"
                role="option"
                :aria-selected="selectedFile === file.path"
                tabindex="0"
                @click="emit('select', file.path, file.section === 'staged')"
                @keydown.enter="emit('select', file.path, file.section === 'staged')"
                @keydown.space.prevent="emit('select', file.path, file.section === 'staged')"
                @contextmenu.prevent.stop="openContextMenu($event, file)"
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

              <!-- Sub-files for expanded untracked directory -->
              <!-- Stay expanded when directory OR one of its sub-files is selected -->
              <li
                v-if="file.path.endsWith('/') && dirFiles?.length && (selectedFile === file.path || dirFiles.includes(selectedFile ?? ''))"
                v-for="subFile in dirFiles"
                :key="`dir-sub-${subFile}`"
                class="file-item file-item--sub"
                :class="{ 'file-item--selected': selectedFile === subFile }"
                role="option"
                tabindex="0"
                @click.stop="emit('select-dir-file', subFile)"
                @keydown.enter.stop="emit('select-dir-file', subFile)"
              >
                <span class="file-status-badge mono" style="color: #16a34a">A</span>
                <div class="file-info">
                  <span class="file-name mono">{{ fileName(subFile) }}</span>
                  <span class="file-dir muted">{{ subFile }}</span>
                </div>
              </li>
            </template>
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

    </div>

    <!-- Commit panel — fixed at bottom, always visible in changes view -->
    <div class="commit-panel" v-if="viewMode === 'changes'">
      <input
        class="commit-summary mono"
        type="text"
        :value="commitSummary"
        @input="onSummaryInput"
        @keydown="onCommitKeydown"
        :placeholder="t('sidebar.summaryPlaceholder')"
      />
      <textarea
        class="commit-description mono"
        :value="commitDescription"
        @input="onDescriptionInput"
        @keydown="onCommitKeydown"
        :placeholder="t('sidebar.descriptionPlaceholder')"
        rows="2"
      ></textarea>
      <div class="commit-actions">
        <button
          class="commit-stage-all"
          v-if="unstagedCount > 0"
          @click="emit('stageAll')"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>{{ t('sidebar.stageAllButton', unstagedCount) }}</span>
        </button>
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
      </div>
      <span class="commit-hint muted">{{ t('sidebar.commitHint') }}</span>
    </div>

    <!-- History view: commit log in sidebar -->
    <div class="sidebar-log" v-if="viewMode === 'history'">
      <CommitLog
        :entries="logEntries"
        :loading="logLoading"
        :selected-hash="selectedCommitHash"
        :ahead-count="aheadCount"
        @select-commit="(hash: string) => emit('selectCommit', hash)"
        @edit-commit="(entry) => emit('editCommit', entry)"
      />
    </div>

    <!-- PRs view: compact PR list in sidebar -->
    <div class="sidebar-prs" v-if="viewMode === 'prs'">
      <PrListSidebar />
    </div>
  </nav>

  <!-- Context menu (Teleport to body to avoid overflow clipping) -->
  <Teleport to="body">
    <div
      v-if="ctxMenu.visible && ctxMenu.file"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <!-- Discard : libellé selon la section -->
      <button
        v-if="ctxMenu.file.section !== 'staged'"
        class="ctx-item ctx-item--danger"
        @click="onCtxDiscard"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <span>{{ ctxMenu.file.section === 'untracked' ? 'Supprimer le fichier' : 'Annuler les modifications' }}</span>
      </button>

      <!-- Separator -->
      <div class="ctx-separator" v-if="ctxMenu.file.section !== 'staged'"></div>

      <!-- Add to .gitignore -->
      <button class="ctx-item" @click="onCtxGitignore">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity="0.5"/>
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span>Ajouter à .gitignore</span>
      </button>
    </div>
  </Teleport>
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

.sidebar-prs {
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

/* Sub-files inside an expanded untracked directory */
.file-item--sub {
  padding-left: 30px;
  background: var(--color-bg);
  border-left-color: transparent;
  border-left-width: 1px;
  position: relative;
}

.file-item--sub::before {
  content: '';
  position: absolute;
  left: 17px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
}

.file-item--sub:first-of-type::before {
  top: 50%;
}

.file-item--sub:hover {
  background: var(--color-bg-tertiary);
}

.file-item--sub.file-item--selected {
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

/* Commit panel — fixed at bottom of sidebar */
.commit-panel {
  border-top: 1px solid var(--color-border);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.commit-summary {
  width: 100%;
  padding: 7px 10px;
  font-size: 11px;
  line-height: 1.5;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
}

.commit-summary:focus {
  border-color: var(--color-accent);
}

.commit-summary::placeholder {
  color: var(--color-text-muted);
}

.commit-description {
  width: 100%;
  padding: 7px 10px;
  font-size: 11px;
  line-height: 1.5;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  resize: vertical;
  min-height: 38px;
  max-height: 120px;
  outline: none;
  transition: border-color 0.15s;
}

.commit-description:focus {
  border-color: var(--color-accent);
}

.commit-description::placeholder {
  color: var(--color-text-muted);
  font-style: italic;
}

.commit-actions {
  display: flex;
  gap: 6px;
}

.commit-stage-all {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 500;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  transition: background 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.commit-stage-all:hover {
  background: var(--color-bg);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.commit-btn {
  flex: 1;
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

<style>
/* Context menu — non-scoped pour Teleport */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 200px;
  background: var(--color-bg-secondary, #1e1e2e);
  border: 1px solid var(--color-border, #313244);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: ctx-fade-in 0.1s ease;
}

@keyframes ctx-fade-in {
  from { opacity: 0; transform: scale(0.95) translateY(-4px); }
  to   { opacity: 1; transform: scale(1)   translateY(0); }
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text, #cdd6f4);
  background: none;
  border-radius: 5px;
  width: 100%;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.ctx-item:hover {
  background: var(--color-bg-tertiary, #313244);
}

.ctx-item--danger {
  color: var(--color-danger, #f38ba8);
}

.ctx-item--danger:hover {
  background: rgba(243, 139, 168, 0.12);
}

.ctx-separator {
  height: 1px;
  background: var(--color-border, #313244);
  margin: 3px 6px;
}
</style>
