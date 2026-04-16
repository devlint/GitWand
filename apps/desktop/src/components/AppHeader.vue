<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { Theme } from "../composables/useTheme";
import type { GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { useMergePreview } from "../composables/useMergePreview";
import MergePreviewPanel from "./MergePreviewPanel.vue";
import { useFolderHistory } from "../composables/useFolderHistory";
import { useUndoStack, type UndoEntry, type UndoOpType } from "../composables/useUndoStack";

const { t } = useI18n();

const props = defineProps<{
  hasFiles: boolean;
  theme: Theme;
  branchDisplay: string;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number };
  hasRepo: boolean;
  folderName: string;
  canPush: boolean;
  canPull: boolean;
  /** True when the current branch has no upstream (first push will publish it). */
  needsPublish?: boolean;
  aheadCount: number;
  behindCount: number;
  isPushing: boolean;
  isPulling: boolean;
  // Branch popover
  branches: GitBranch[];
  branchesLoading: boolean;
  isSwitchingBranch: boolean;
  isMerging: boolean;
  /** Path to the current repository (for merge preview) */
  cwd: string;
}>();

const emit = defineEmits<{
  openFolder: [];
  openRepo: [path: string];
  toggleTheme: [];
  push: [];
  pull: [];
  mergeBranch: [name: string];
  openSettings: [];
  switchBranch: [name: string];
  createBranch: [name: string];
  deleteBranch: [name: string];
  loadBranches: [];
  undoPerformed: [];
  openRebase: [];
}>();

// ─── Recent repos popover (Phase 8.4) ────────────────
const { history: recentRepos, togglePin, removeFromHistory } = useFolderHistory();

const showRecentPopover = ref(false);

function toggleRecentPopover() {
  showRecentPopover.value = !showRecentPopover.value;
}

function closeRecentPopover() {
  showRecentPopover.value = false;
}

function openRecentRepo(path: string) {
  emit("openRepo", path);
  closeRecentPopover();
}

// ─── Branch popover ──────────────────────────────────
const showBranchPopover = ref(false);
const branchFilter = ref("");
const showBranchCreate = ref(false);
const newBranchName = ref("");

function toggleBranchPopover() {
  showBranchPopover.value = !showBranchPopover.value;
  if (showBranchPopover.value) {
    branchFilter.value = "";
    emit("loadBranches");
  }
}

function closeBranchPopover() {
  showBranchPopover.value = false;
  showBranchCreate.value = false;
  newBranchName.value = "";
}

const mainNames = ["main", "master"];

function branchSort(a: typeof props.branches[0], b: typeof props.branches[0]): number {
  // Current branch always first
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  // main/master next
  const aName = a.name.replace(/^origin\//, "").toLowerCase();
  const bName = b.name.replace(/^origin\//, "").toLowerCase();
  const aMain = mainNames.includes(aName) ? 0 : 1;
  const bMain = mainNames.includes(bName) ? 0 : 1;
  if (aMain !== bMain) return aMain - bMain;
  // Then by last commit date (most recent first)
  if (a.lastCommitDate && b.lastCommitDate) {
    const da = new Date(a.lastCommitDate).getTime();
    const db = new Date(b.lastCommitDate).getTime();
    if (da !== db) return db - da;
  }
  return a.name.localeCompare(b.name);
}

const localBranches = computed(() =>
  props.branches
    .filter((b) => !b.isRemote)
    .filter((b) => !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()))
    .sort(branchSort),
);

const remoteBranches = computed(() =>
  props.branches
    .filter((b) => b.isRemote)
    .filter((b) => !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()))
    .sort(branchSort),
);

function handleBranchSwitch(name: string) {
  emit("switchBranch", name);
  closeBranchPopover();
}

function handleBranchCreate() {
  const name = newBranchName.value.trim();
  if (!name) return;
  emit("createBranch", name);
  newBranchName.value = "";
  showBranchCreate.value = false;
  closeBranchPopover();
}

function onCreateKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    handleBranchCreate();
  } else if (e.key === "Escape") {
    showBranchCreate.value = false;
    newBranchName.value = "";
  }
}

// ─── Merge popover ──────────────────────────────────
const showMergePopover = ref(false);
const mergeFilter = ref("");

function toggleMergePopover() {
  showMergePopover.value = !showMergePopover.value;
  if (showMergePopover.value) {
    mergeFilter.value = "";
    emit("loadBranches");
  }
}

function closeMergePopover() {
  showMergePopover.value = false;
}

/** Branches available for merging: all except the current one, main/master first. */
const mergeBranches = computed(() => {
  const filter = mergeFilter.value.toLowerCase();
  return props.branches
    .filter((b) => !b.isCurrent)
    .filter((b) => !filter || b.name.toLowerCase().includes(filter))
    .sort(branchSort);
});

function handleMerge(name: string) {
  emit("mergeBranch", name);
  closeMergePopover();
}

// ─── Merge Preview (Phase 8.1) ──────────────────────────
const {
  loading: previewLoading,
  error: previewError,
  summary: previewSummary,
  conflictingFiles: previewConflicts,
  computePreview,
  reset: resetPreview,
} = useMergePreview(() => props.cwd);

const previewingBranch = ref<string | null>(null);

async function togglePreview(branchName: string) {
  if (previewingBranch.value === branchName) {
    previewingBranch.value = null;
    resetPreview();
    return;
  }
  previewingBranch.value = branchName;
  await computePreview(branchName);
}

function closePreview() {
  previewingBranch.value = null;
  resetPreview();
}

// Close popovers on click outside
function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (showBranchPopover.value && !target.closest(".branch-popover-wrapper")) {
    closeBranchPopover();
  }
  if (showMergePopover.value && !target.closest(".merge-popover-wrapper")) {
    closeMergePopover();
  }
  if (showRecentPopover.value && !target.closest(".recent-popover-wrapper")) {
    closeRecentPopover();
  }
  if (showUndoPopover.value && !target.closest(".undo-popover-wrapper")) {
    closeUndoPopover();
  }
}

// ─── Undo stack (Phase 1.2.4) ──────────────────────────
const undoStack = useUndoStack();
const showUndoPopover = ref(false);

function toggleUndoPopover() {
  showUndoPopover.value = !showUndoPopover.value;
  if (showUndoPopover.value && props.cwd) {
    undoStack.refresh(props.cwd);
  }
}

function closeUndoPopover() {
  showUndoPopover.value = false;
}

/** Map operation type to i18n key suffix. */
function opLabel(type: UndoOpType): string {
  const map: Record<UndoOpType, string> = {
    commit: t("undoStack.opCommit"),
    amend: t("undoStack.opAmend"),
    merge: t("undoStack.opMerge"),
    "cherry-pick": t("undoStack.opCherryPick"),
    rebase: t("undoStack.opRebase"),
    pull: t("undoStack.opPull"),
    reset: t("undoStack.opReset"),
    checkout: t("undoStack.opCheckout"),
    stash: t("undoStack.opStash"),
    other: t("undoStack.opOther"),
  };
  return map[type] ?? type;
}

/** True when the undo is a hard reset (destructive). */
function isHardUndo(entry: UndoEntry): boolean {
  return entry.type !== "commit" && entry.type !== "amend";
}

async function handleUndo(entry: UndoEntry) {
  const msg = isHardUndo(entry)
    ? t("undoStack.undoHardConfirm")
    : t("undoStack.undoConfirm");
  if (!confirm(msg)) return;
  try {
    await undoStack.undo(props.cwd, entry);
    closeUndoPopover();
    // Emit a lightweight signal so App.vue can refresh the repo state.
    emit("undoPerformed");
  } catch {
    // lastError is set by the composable — shown in the popover.
  }
}

// Auto-load reflog when repo is available (so the Undo button reflects state)
watch(() => props.cwd, (cwd) => {
  if (cwd) undoStack.refresh(cwd);
}, { immediate: true });

onMounted(() => document.addEventListener("click", onDocClick, true));
onUnmounted(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <!-- 3D hex cube logo — flat-top R=30, inner r=15, viewBox 80×70 -->
      <svg class="logo" width="28" height="24" viewBox="0 0 80 70" fill="none" aria-hidden="true">
        <!-- back wall -->
        <path d="M 55,35 L 47.5,22 L 32.5,22 L 25,35 L 32.5,48 L 47.5,48 Z" fill="none"/>
        <!-- top face — lightest -->
        <path d="M 10,35 L 25,9 L 55,9 L 70,35 L 55,35 L 47.5,22 L 32.5,22 L 25,35 Z" fill="#8B5CF6"/>
        <!-- lower-right face — darkest -->
        <path d="M 70,35 L 55,61 L 47.5,48 L 55,35 Z" fill="#4C1D95"/>
        <!-- lower-left face — medium -->
        <path d="M 10,35 L 25,35 L 32.5,48 L 25,61 Z" fill="#6D28D9"/>
        <!-- bottom face — medium-dark -->
        <path d="M 25,61 L 55,61 L 47.5,48 L 32.5,48 Z" fill="#5B21B6"/>
      </svg>
      <h1 class="title">GitWand</h1>

      <!-- Folder name + recent repos popover -->
      <div class="recent-popover-wrapper" v-if="hasRepo && folderName">
        <button
          class="folder-trigger"
          @click="toggleRecentPopover"
          :title="t('header.openFolder')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
          <span class="folder-name">{{ folderName }}</span>
          <svg class="folder-chevron" :class="{ 'folder-chevron--open': showRecentPopover }" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2.5 3.5l2.5 3 2.5-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        <div v-if="showRecentPopover" class="recent-popover">
          <!-- Open new folder option -->
          <button class="rp-open-btn" @click="emit('openFolder'); closeRecentPopover()">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
            <span>{{ t('header.openFolder') }}</span>
          </button>

          <div class="rp-divider" v-if="recentRepos.length > 0"></div>

          <!-- Recent repos list -->
          <div class="rp-list" v-if="recentRepos.length > 0">
            <div class="rp-label">{{ t('empty.recentTitle') }}</div>
            <ul>
              <li
                v-for="entry in recentRepos"
                :key="entry.path"
                class="rp-item"
                :class="{ 'rp-item--active': entry.path === cwd }"
              >
                <button class="rp-item-name" @click="openRecentRepo(entry.path)" :title="entry.path">
                  <svg v-if="entry.pinned" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="rp-pin-icon">
                    <path d="M10 2L14 6L9 11L8 14L5 11L2 14L5 11L2 8L5 7L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                  </svg>
                  <span class="rp-item-repo-name">{{ entry.name }}</span>
                </button>
                <div class="rp-item-actions">
                  <button
                    class="rp-action"
                    @click.stop="togglePin(entry.path)"
                    :title="entry.pinned ? t('folderPicker.unpin') : t('folderPicker.pin')"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M10 2L14 6L9 11L8 14L5 11L2 14L5 11L2 8L5 7L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                    </svg>
                  </button>
                  <button
                    class="rp-action rp-action--remove"
                    @click.stop="removeFromHistory(entry.path)"
                    :title="t('folderPicker.remove')"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Folder button when no repo open (no dropdown needed) -->
      <button
        v-else-if="!hasRepo"
        class="folder-trigger"
        @click="emit('openFolder')"
        :title="t('header.openFolder')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
        <span class="folder-name">{{ t('header.open') }}</span>
      </button>
    </div>

    <div class="header-center">
      <template v-if="hasRepo">
        <div class="branch-popover-wrapper">
          <button class="branch-trigger" :class="{ 'branch-trigger--loading': isSwitchingBranch }" @click="toggleBranchPopover" :title="t('branches.title')">
            <svg v-if="isSwitchingBranch" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
              <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
              <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
              <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
              <path d="M5 6v4M7 4h3c1.1 0 2 .9 2 2v0" stroke="currentColor" stroke-width="1.3"/>
            </svg>
            <span class="branch-name mono">{{ branchDisplay }}</span>
            <svg class="branch-chevron" :class="{ 'branch-chevron--open': showBranchPopover }" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2.5 3.5l2.5 3 2.5-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>

          <!-- Branch popover -->
          <div v-if="showBranchPopover" class="branch-popover">
            <div class="bp-header">
              <input
                class="bp-filter"
                v-model="branchFilter"
                :placeholder="t('branches.filter')"
                autofocus
                @keydown.escape="closeBranchPopover"
              />
              <button class="bp-action-btn" @click="showBranchCreate = !showBranchCreate" :title="t('branches.create')">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            </div>

            <!-- Create form -->
            <div class="bp-create" v-if="showBranchCreate">
              <input
                class="bp-create-input mono"
                v-model="newBranchName"
                @keydown="onCreateKeydown"
                :placeholder="t('branches.namePlaceholder')"
                autofocus
              />
              <button
                class="bp-create-btn"
                :disabled="!newBranchName.trim()"
                @click="handleBranchCreate"
              >{{ t('common.create') }}</button>
            </div>

            <div class="bp-loading" v-if="branchesLoading">
              <div class="bp-spinner"></div>
            </div>
            <div class="bp-lists" v-else>
              <!-- Local -->
              <div class="bp-section" v-if="localBranches.length > 0">
                <div class="bp-section-label">{{ t('branches.local') }}</div>
                <ul class="bp-list">
                  <template v-for="branch in localBranches" :key="branch.name">
                    <li
                      class="bp-item"
                      :class="{ 'bp-item--current': branch.isCurrent }"
                      @click="!branch.isCurrent && handleBranchSwitch(branch.name)"
                    >
                      <span class="bp-current-dot" v-if="branch.isCurrent"></span>
                      <span class="bp-item-name mono">{{ branch.name }}</span>
                      <span class="bp-item-meta muted" v-if="branch.ahead > 0 || branch.behind > 0">
                        <span v-if="branch.ahead > 0">&uarr;{{ branch.ahead }}</span>
                        <span v-if="branch.behind > 0">&darr;{{ branch.behind }}</span>
                      </span>
                      <button
                        v-if="!branch.isCurrent"
                        class="bp-item-preview"
                        :class="{ 'bp-item-preview--active': previewingBranch === branch.name }"
                        @click.stop="togglePreview(branch.name)"
                        :title="t('branches.previewMerge')"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                          <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                      </button>
                      <button
                        v-if="!branch.isCurrent"
                        class="bp-item-delete"
                        @click.stop="emit('deleteBranch', branch.name)"
                        :title="t('branches.deleteLabel')"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                      </button>
                    </li>
                    <li v-if="previewingBranch === branch.name" class="bp-preview-row">
                      <MergePreviewPanel
                        :loading="previewLoading"
                        :error="previewError"
                        :summary="previewSummary"
                        :conflicting-files="previewConflicts"
                        @close="closePreview"
                      />
                    </li>
                  </template>
                </ul>
              </div>
              <!-- Remote -->
              <div class="bp-section" v-if="remoteBranches.length > 0">
                <div class="bp-section-label">{{ t('branches.remote') }}</div>
                <ul class="bp-list">
                  <li
                    v-for="branch in remoteBranches"
                    :key="branch.name"
                    class="bp-item bp-item--remote"
                    @click="handleBranchSwitch(branch.name.replace(/^origin\//, ''))"
                  >
                    <span class="bp-item-name mono">{{ branch.name }}</span>
                  </li>
                </ul>
              </div>
              <div class="bp-empty" v-if="localBranches.length === 0 && remoteBranches.length === 0">
                <span class="muted">{{ t('branches.noBranch') }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="repo-stat-group" v-if="repoStats.staged + repoStats.unstaged + repoStats.untracked + repoStats.conflicted > 0">
          <span class="repo-stat" v-if="repoStats.staged > 0">
            <span class="repo-stat-dot" style="background: var(--color-success)"></span>
            {{ repoStats.staged }} {{ t('header.staged') }}
          </span>
          <span class="repo-stat" v-if="repoStats.unstaged > 0">
            <span class="repo-stat-dot" style="background: var(--color-warning)"></span>
            {{ repoStats.unstaged }} {{ t('header.modified') }}
          </span>
          <span class="repo-stat" v-if="repoStats.untracked > 0">
            <span class="repo-stat-dot" style="background: var(--color-text-muted)"></span>
            {{ repoStats.untracked }} {{ t('header.untracked') }}
          </span>
          <span class="repo-stat" v-if="repoStats.conflicted > 0">
            <span class="repo-stat-dot" style="background: var(--color-danger)"></span>
            {{ repoStats.conflicted }} {{ t('header.conflicts') }}
          </span>
        </div>
      </template>
    </div>

    <div class="header-right">
      <!-- Sync / Push -->
      <template v-if="hasRepo">
        <button
          class="btn btn--sync"
          :class="{ 'btn--disabled': !canPull, 'btn--sync-active': behindCount > 0 }"
          :disabled="!canPull"
          @click="emit('pull')"
          :title="t('header.syncTooltip')"
        >
          <svg v-if="isPulling" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M5 10l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('header.sync') }}</span>
          <span v-if="behindCount > 0" class="sync-badge sync-badge--pull">{{ behindCount }}</span>
        </button>
        <button
          class="btn btn--sync btn--push"
          :class="{
            'btn--disabled': !canPush,
            'btn--sync-active': aheadCount > 0 || needsPublish,
          }"
          :disabled="!canPush"
          @click="emit('push')"
          :title="needsPublish ? t('header.publishTooltip') : `${t('header.push')} (${aheadCount})`"
        >
          <svg v-if="isPushing" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ needsPublish ? t('header.publish') : t('header.push') }}</span>
          <span v-if="aheadCount > 0" class="sync-badge sync-badge--push">{{ aheadCount }}</span>
        </button>

        <!-- Merge from branch -->
        <div class="merge-popover-wrapper">
          <button
            class="btn btn--sync btn--merge"
            :class="{ 'btn--disabled': isMerging }"
            :disabled="isMerging"
            @click="toggleMergePopover"
            :title="t('header.mergeTooltip')"
          >
            <svg v-if="isMerging" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
              <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
              <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
              <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
              <path d="M5 6v4M10 8H7c-1.1 0-2-.9-2-2" stroke="currentColor" stroke-width="1.3"/>
            </svg>
            <span>{{ t('header.merge') }}</span>
          </button>

          <!-- Merge branch picker popover -->
          <div v-if="showMergePopover" class="merge-popover">
            <div class="mp-header">
              <input
                class="mp-filter"
                v-model="mergeFilter"
                :placeholder="t('header.mergeFilterPlaceholder')"
                autofocus
                @keydown.escape="closeMergePopover"
              />
            </div>
            <div class="mp-loading" v-if="branchesLoading">
              <div class="mp-spinner"></div>
            </div>
            <div class="mp-list-wrapper" v-else>
              <ul class="mp-list" v-if="mergeBranches.length > 0">
                <li
                  v-for="branch in mergeBranches"
                  :key="branch.name"
                  class="mp-item"
                  :class="{ 'mp-item--remote': branch.isRemote }"
                  @click="handleMerge(branch.isRemote ? branch.name : branch.name)"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
                    <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
                    <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
                    <path d="M5 6v4M10 8H7c-1.1 0-2-.9-2-2" stroke="currentColor" stroke-width="1.3"/>
                  </svg>
                  <span class="mp-item-name mono">{{ branch.name }}</span>
                  <span class="mp-item-tag" v-if="branch.isRemote">remote</span>
                </li>
              </ul>
              <div class="mp-empty" v-else>
                <span class="muted">{{ t('branches.noBranch') }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Rebase interactif (Phase 1.2.1) -->
        <button
          class="btn btn--sync"
          @click="emit('openRebase')"
          :title="t('rebase.title')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="4" cy="3" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/>
            <circle cx="4" cy="13" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/>
            <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/>
            <path d="M4 5v6M4 5c0 2 2 3 6 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <span>{{ t('rebase.button') }}</span>
        </button>

        <!-- Undo (Phase 1.2.4) -->
        <div class="undo-popover-wrapper">
          <button
            class="btn btn--sync"
            :class="{ 'btn--sync-active': undoStack.lastUndoable.value }"
            :disabled="!undoStack.lastUndoable.value"
            @click="toggleUndoPopover"
            :title="t('undoStack.undoTooltip')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 6.5A6 6 0 1 1 3.5 11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
              <path d="M9 6.4V9l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3.5 3v3.5H7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>{{ t('undoStack.undoButton') }}</span>
          </button>

          <!-- Undo history popover -->
          <div v-if="showUndoPopover" class="undo-popover">
            <div class="undo-popover-title">{{ t('undoStack.title') }}</div>
            <div v-if="undoStack.lastError.value" class="undo-error">{{ undoStack.lastError.value }}</div>
            <div v-if="undoStack.isLoading.value" class="undo-loading">
              <div class="mp-spinner"></div>
            </div>
            <ul v-else-if="undoStack.entries.value.length > 0" class="undo-list">
              <li
                v-for="entry in undoStack.entries.value.slice(0, 20)"
                :key="entry.index"
                class="undo-entry"
                :class="{ 'undo-entry--undoable': undoStack.canUndo(entry) }"
              >
                <div class="undo-entry-info">
                  <span class="undo-entry-type">{{ opLabel(entry.type) }}</span>
                  <span class="undo-entry-summary mono">{{ entry.summary }}</span>
                  <span class="undo-entry-date muted">{{ entry.date }}</span>
                </div>
                <button
                  v-if="undoStack.canUndo(entry)"
                  class="undo-entry-btn"
                  :class="{ 'undo-entry-btn--hard': isHardUndo(entry) }"
                  @click="handleUndo(entry)"
                  :title="t('undoStack.undoButton')"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.4" fill="none"/>
                    <path d="M9 6.4V9l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M3.5 3v3.5H7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M3.5 6.5A6 6 0 019 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
                  </svg>
                </button>
              </li>
            </ul>
            <div v-else class="undo-empty">{{ t('undoStack.noHistory') }}</div>
          </div>
        </div>

        <div class="header-separator"></div>
      </template>

      <!-- Theme toggle -->
      <button
        class="btn btn--icon theme-toggle"
        @click="emit('toggleTheme')"
        :aria-label="theme === 'dark' ? t('header.themeLight') : t('header.themeDark')"
        :title="theme === 'dark' ? t('header.themeLightLabel') : t('header.themeDarkLabel')"
      >
        <!-- Sun icon (shown in dark mode → click to go light) -->
        <svg v-if="theme === 'dark'" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/>
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <!-- Moon icon (shown in light mode → click to go dark) -->
        <svg v-else width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M14 9.3A6 6 0 016.7 2 6 6 0 1014 9.3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
      </button>

      <!-- Settings -->
      <button
        class="btn btn--icon"
        @click="emit('openSettings')"
        :aria-label="t('settings.title')"
        :title="t('settings.title')"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <circle cx="5.5" cy="4" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="10.5" cy="8" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="7" cy="12" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 var(--space-6);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  gap: var(--space-6);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.logo {
  flex-shrink: 0;
}

.title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
}

/* Mode switcher */
/* Branch trigger & popover */
.branch-popover-wrapper {
  position: relative;
}

.branch-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-pill);
  color: var(--color-text);
  background: var(--color-bg-tertiary);
  transition: background var(--transition-base), color var(--transition-base);
  cursor: pointer;
}

.branch-trigger:hover {
  background: var(--color-border);
}

.branch-trigger--loading {
  opacity: 0.7;
  pointer-events: none;
}

.branch-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
}

.branch-chevron {
  transition: transform var(--transition-base);
  opacity: 0.5;
}

.branch-chevron--open {
  transform: rotate(180deg);
}

/* ─── Branch Popover ─────────────────────────────────── */

.branch-popover {
  position: absolute;
  top: calc(100% + var(--space-3));
  left: 50%;
  transform: translateX(-50%);
  width: 340px;
  max-height: 520px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  z-index: 50;
  animation: bpSlide var(--transition-slow);
  overflow: hidden;
}

@keyframes bpSlide {
  from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.bp-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.bp-filter {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-base);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.bp-filter:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.bp-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: none;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.bp-action-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.bp-create {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.bp-create-input {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-base);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  outline: none;
}

.bp-create-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.bp-create-btn {
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-radius: var(--radius-pill);
}

.bp-create-btn:disabled {
  opacity: 0.4;
}

.bp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.bp-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: var(--radius-pill);
  animation: spin 0.7s linear infinite;
}

.bp-lists {
  flex: 1;
  overflow-y: auto;
  max-height: 300px;
}

.bp-section {
  border-bottom: 1px solid var(--color-border);
}

.bp-section:last-child {
  border-bottom: none;
}

.bp-section-label {
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  background: var(--color-bg);
}

.bp-list {
  list-style: none;
}

.bp-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  cursor: pointer;
  transition: background var(--transition-fast);
  font-size: var(--font-size-base);
}

.bp-item:hover {
  background: var(--color-bg-tertiary);
}

.bp-item--current {
  background: var(--color-bg-tertiary);
  cursor: default;
}

.bp-current-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  flex-shrink: 0;
}

.bp-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--font-weight-medium);
}

.bp-item--remote .bp-item-name {
  opacity: 0.7;
}

.bp-item-meta {
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

.bp-item-preview,
.bp-item-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}

.bp-item:hover .bp-item-preview,
.bp-item:hover .bp-item-delete {
  opacity: 0.6;
}

.bp-item-preview:hover {
  opacity: 1 !important;
  color: var(--color-accent);
}

.bp-item-preview--active {
  opacity: 1 !important;
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.bp-item-delete:hover {
  opacity: 1 !important;
  color: var(--color-danger);
}

.bp-preview-row {
  list-style: none;
  padding: var(--space-2) var(--space-4) var(--space-3);
}

.bp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-7);
  font-size: var(--font-size-base);
}

.repo-stat-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-5);
}

.repo-stat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.repo-stat-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}

.header-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}

/* Folder trigger */
.folder-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  margin-left: var(--space-2);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: transparent;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  transition: background var(--transition-base), color var(--transition-base);
  cursor: pointer;
  max-width: 220px;
}

.folder-trigger:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.header-separator {
  width: 1px;
  height: 20px;
  background: var(--color-border);
  flex-shrink: 0;
  margin-inline: var(--space-2);
}

/* Local button override — pill-style header buttons.
   Note: global .btn lives in main.css; these scoped rules refine the
   header variants (sync / merge / icon) to match the design system. */
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  transition: background var(--transition-base), color var(--transition-base), transform var(--transition-fast);
  white-space: nowrap;
}

.btn:active:not(:disabled) { transform: translateY(1px); }

.btn--secondary {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
.btn--secondary:hover:not(:disabled) { background: var(--color-border); }

.btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
}
.btn--primary:hover:not(:disabled) { background: var(--color-accent-hover); }

/* Sync buttons (Push/Pull) */
.btn--sync {
  position: relative;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--sync:hover:not(:disabled) { background: var(--color-border); }

.btn--sync-active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.btn--push.btn--sync-active {
  background: var(--color-accent);
  color: var(--color-accent-text);
}

.btn--push.btn--sync-active:hover:not(:disabled) { background: var(--color-accent-hover); }

.sync-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.sync-badge--push {
  background: rgba(255, 255, 255, 0.22);
  color: var(--color-accent-text);
}

.sync-badge--pull {
  background: var(--color-accent);
  color: var(--color-accent-text);
}

.btn--save {
  background: var(--color-success);
  color: var(--color-accent-text);
}
.btn--save:hover { filter: brightness(1.08); }

.btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-muted);
  transition: background var(--transition-base), color var(--transition-base);
}
.btn--icon:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--icon:disabled,
.btn--disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-spinner { animation: spin 0.7s linear infinite; }

@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Merge Popover ──────────────────────────────────── */

.merge-popover-wrapper {
  position: relative;
}

.merge-popover {
  position: absolute;
  top: calc(100% + var(--space-3));
  right: 0;
  width: 300px;
  max-height: 360px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  z-index: 50;
  animation: bpSlide var(--transition-slow);
  overflow: hidden;
}

.mp-header {
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.mp-filter {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-base);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.mp-filter:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.mp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.mp-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: var(--radius-pill);
  animation: spin 0.7s linear infinite;
}

.mp-list-wrapper {
  flex: 1;
  overflow-y: auto;
  max-height: 280px;
}

.mp-list { list-style: none; }

.mp-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  cursor: pointer;
  transition: background var(--transition-fast);
  font-size: var(--font-size-base);
  color: var(--color-text);
}

.mp-item:hover { background: var(--color-bg-tertiary); }

.mp-item--remote { opacity: 0.7; }

.mp-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--font-weight-medium);
}

.mp-item-tag {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.mp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-7);
  font-size: var(--font-size-base);
}

/* ─── Recent Repos Popover (Phase 8.4) ──────────────── */

.recent-popover-wrapper {
  position: relative;
}

.folder-chevron {
  transition: transform var(--transition-base);
  opacity: 0.4;
  margin-left: var(--space-1);
}

.folder-chevron--open { transform: rotate(180deg); }

.recent-popover {
  position: absolute;
  top: calc(100% + var(--space-3));
  left: 0;
  width: 280px;
  max-height: 380px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  z-index: 50;
  animation: bpSlide var(--transition-slow);
  overflow: hidden;
}

.rp-open-btn {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-5) var(--space-5);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  background: none;
  text-align: left;
  transition: background var(--transition-fast);
}

.rp-open-btn:hover { background: var(--color-bg-tertiary); }

.rp-divider {
  height: 1px;
  background: var(--color-border);
}

.rp-list {
  flex: 1;
  overflow-y: auto;
  max-height: 300px;
}

.rp-label {
  padding: var(--space-4) var(--space-5) var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.rp-list ul { list-style: none; }

.rp-item {
  display: flex;
  align-items: center;
  padding: 0 var(--space-3) 0 0;
  transition: background var(--transition-fast);
}

.rp-item:hover,
.rp-item--active {
  background: var(--color-bg-tertiary);
}

.rp-item-name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  background: none;
  text-align: left;
  overflow: hidden;
  min-width: 0;
}

.rp-pin-icon {
  flex-shrink: 0;
  color: var(--color-accent);
}

.rp-item-repo-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rp-item-actions {
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--transition-fast);
  flex-shrink: 0;
}

.rp-item:hover .rp-item-actions { opacity: 1; }

.rp-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: none;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.rp-action:hover {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.rp-action--remove:hover {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

/* ─── Undo popover ──────────────────────────────────── */
.undo-popover-wrapper {
  position: relative;
}

.undo-popover {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  width: 340px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  z-index: 200;
  overflow: hidden;
}

.undo-popover-title {
  padding: 10px 14px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
}

.undo-error {
  padding: 8px 14px;
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}

.undo-loading {
  padding: 20px;
  display: flex;
  justify-content: center;
}

.undo-list {
  list-style: none;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  flex: 1;
}

.undo-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--color-border-light, var(--color-border));
  transition: background var(--transition-base);
}

.undo-entry:last-child {
  border-bottom: none;
}

.undo-entry:hover {
  background: var(--color-bg-tertiary);
}

.undo-entry-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.undo-entry-type {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-accent);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.undo-entry-summary {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.undo-entry-date {
  font-size: var(--font-size-xs);
}

.undo-entry-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-accent);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-base), background var(--transition-base), border-color var(--transition-base);
}

.undo-entry:hover .undo-entry-btn {
  opacity: 1;
}

.undo-entry-btn:hover {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}

.undo-entry-btn--hard {
  color: var(--color-warning);
}

.undo-entry-btn--hard:hover {
  background: var(--color-warning-soft, rgba(234, 179, 8, 0.1));
  border-color: var(--color-warning);
}

.undo-empty {
  padding: 20px 14px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
</style>
