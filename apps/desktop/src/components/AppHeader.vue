<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import type { Theme } from "../composables/useTheme";
import type { GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { useMergePreview } from "../composables/useMergePreview";
import MergePreviewPanel from "./MergePreviewPanel.vue";
import { useFolderHistory } from "../composables/useFolderHistory";

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
}

onMounted(() => document.addEventListener("click", onDocClick, true));
onUnmounted(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <svg class="logo" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--color-accent)" />
        <path d="M18 14L19 17L22 18L19 19L18 22L17 19L14 18L17 17L18 14Z" fill="var(--color-warning)" opacity="0.8" />
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
          :class="{ 'btn--disabled': !canPush, 'btn--sync-active': aheadCount > 0 }"
          :disabled="!canPush"
          @click="emit('push')"
          :title="`Push (${aheadCount})`"
        >
          <svg v-if="isPushing" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('header.push') }}</span>
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
  padding: 0 16px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  gap: 16px;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo {
  flex-shrink: 0;
}

.title {
  font-size: 15px;
  font-weight: 600;
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
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--color-text);
  background: none;
  transition: background 0.12s;
  cursor: pointer;
}

.branch-trigger:hover {
  background: var(--color-bg-tertiary);
}

.branch-trigger--loading {
  opacity: 0.7;
  pointer-events: none;
}

.branch-name {
  font-size: 13px;
  font-weight: 500;
}

.branch-chevron {
  transition: transform 0.15s;
  opacity: 0.5;
}

.branch-chevron--open {
  transform: rotate(180deg);
}

/* ─── Branch Popover ─────────────────────────────────── */

.branch-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: 340px;
  max-height: 520px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  z-index: 50;
  animation: bpSlide 0.15s ease-out;
}

@keyframes bpSlide {
  from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.bp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
}

.bp-filter {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  outline: none;
}

.bp-filter:focus {
  border-color: var(--color-accent);
}

.bp-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  color: var(--color-text-muted);
  background: none;
  transition: background 0.1s, color 0.1s;
}

.bp-action-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.bp-create {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
}

.bp-create-input {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  outline: none;
}

.bp-create-input:focus {
  border-color: var(--color-accent);
}

.bp-create-btn {
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  background: var(--color-accent);
  color: #fff;
  border-radius: 5px;
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
  border-radius: 50%;
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
  padding: 5px 12px;
  font-size: 10px;
  font-weight: 600;
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
  gap: 6px;
  padding: 5px 12px;
  cursor: pointer;
  transition: background 0.1s;
  font-size: 12px;
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
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}

.bp-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.bp-item--remote .bp-item-name {
  opacity: 0.7;
}

.bp-item-meta {
  font-size: 10px;
  flex-shrink: 0;
}

.bp-item-preview,
.bp-item-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity 0.1s, color 0.1s, background 0.1s;
}

.bp-item:hover .bp-item-preview,
.bp-item:hover .bp-item-delete {
  opacity: 0.6;
}

.bp-item-preview:hover {
  opacity: 1 !important;
  color: var(--color-accent, #89b4fa);
}

.bp-item-preview--active {
  opacity: 1 !important;
  color: var(--color-accent, #89b4fa);
  background: var(--color-accent-bg, #89b4fa20);
}

.bp-item-delete:hover {
  opacity: 1 !important;
  color: var(--color-danger);
}

.bp-preview-row {
  list-style: none;
  padding: 4px 8px 6px;
}

.bp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  font-size: 12px;
}

.repo-stat-group {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: 16px;
}

.repo-stat {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.repo-stat-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.header-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* Folder trigger */
.folder-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  margin-left: 8px;
  border-left: 1px solid var(--color-border);
  padding-left: 16px;
  border-radius: 0;
  color: var(--color-text-muted);
  background: none;
  font-size: 12px;
  transition: background 0.12s, color 0.12s;
  cursor: pointer;
  max-width: 200px;
}

.folder-trigger:hover {
  color: var(--color-text);
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
  gap: 8px;
}

.header-separator {
  width: 1px;
  height: 20px;
  background: var(--color-border);
  flex-shrink: 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}

.btn--secondary {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--secondary:hover {
  background: var(--color-border);
}

.btn--primary {
  background: var(--color-accent);
  color: #fff;
}

.btn--primary:hover {
  background: var(--color-accent-hover);
}

/* Sync buttons (Push/Pull) */
.btn--sync {
  position: relative;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--sync:hover:not(:disabled) {
  background: var(--color-border);
}

.btn--sync-active {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--push.btn--sync-active {
  background: var(--color-accent);
  color: #fff;
}

.btn--push.btn--sync-active:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.sync-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 2px 5px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.sync-badge--push {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.sync-badge--pull {
  background: var(--color-accent);
  color: #fff;
}

.btn--save {
  background: var(--color-success);
  color: #fff;
}

.btn--save:hover {
  filter: brightness(1.1);
}

.btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  background: none;
  color: var(--color-text-muted);
  transition: color 0.12s;
}

.btn--icon:hover:not(:disabled) {
  color: var(--color-text);
}

.btn--icon:disabled,
.btn--disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.btn-spinner {
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ─── Merge Popover ──────────────────────────────────── */

.merge-popover-wrapper {
  position: relative;
}

.merge-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 300px;
  max-height: 360px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  z-index: 50;
  animation: bpSlide 0.15s ease-out;
}

.mp-header {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
}

.mp-filter {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  outline: none;
  box-sizing: border-box;
}

.mp-filter:focus {
  border-color: var(--color-accent);
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
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.mp-list-wrapper {
  flex: 1;
  overflow-y: auto;
  max-height: 280px;
}

.mp-list {
  list-style: none;
}

.mp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.1s;
  font-size: 12px;
  color: var(--color-text);
}

.mp-item:hover {
  background: var(--color-bg-tertiary);
}

.mp-item--remote {
  opacity: 0.7;
}

.mp-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.mp-item-tag {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--color-bg);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.mp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  font-size: 12px;
}

/* ─── Recent Repos Popover (Phase 8.4) ──────────────── */

.recent-popover-wrapper {
  position: relative;
}

.folder-chevron {
  transition: transform 0.15s;
  opacity: 0.4;
  margin-left: 2px;
}

.folder-chevron--open {
  transform: rotate(180deg);
}

.recent-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 280px;
  max-height: 380px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  z-index: 50;
  animation: bpSlide 0.15s ease-out;
  overflow: hidden;
}

.rp-open-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
  background: none;
  text-align: left;
  transition: background 0.1s;
}

.rp-open-btn:hover {
  background: var(--color-bg-tertiary);
}

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
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.rp-list ul {
  list-style: none;
}

.rp-item {
  display: flex;
  align-items: center;
  padding: 0 6px 0 0;
  transition: background 0.1s;
}

.rp-item:hover {
  background: var(--color-bg-tertiary);
}

.rp-item--active {
  background: var(--color-bg-tertiary);
}

.rp-item-name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
  background: none;
  text-align: left;
  overflow: hidden;
  min-width: 0;
}

.rp-pin-icon {
  flex-shrink: 0;
  color: var(--color-accent, #89b4fa);
}

.rp-item-repo-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rp-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s;
  flex-shrink: 0;
}

.rp-item:hover .rp-item-actions {
  opacity: 1;
}

.rp-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--color-text-muted);
  background: none;
  transition: color 0.1s;
}

.rp-action:hover {
  color: var(--color-accent, #89b4fa);
}

.rp-action--remove:hover {
  color: var(--color-danger);
}
</style>
