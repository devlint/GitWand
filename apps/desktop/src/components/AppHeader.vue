<script setup lang="ts">
/**
 * AppHeader — header refondu.
 *
 * Layout:
 *   ┌─ Logo + Tabs row ─────────────────────────────────────────┐
 *   │  [logo] | [repo1]  [repo2]  +                             │
 *   ├───────────────────────────────────────────────────────────┤
 *   │  [branch ▾]   stats          [sync▾] [branch▾] [🔍] [🌙] [⚙] │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Composition
 * ───────────
 * This file is a layout/composition shell. Heavy behaviour lives in
 * dedicated components under `components/header/`:
 *   - RepoTabStrip      — multi-repo tab bar (row 1)
 *   - HeaderLogo        — brand mark + app name
 *   - BranchSelector    — branch chip trigger + popover (create / switch
 *                         / preview-merge / worktree / delete)
 *   - SearchTrigger     — global search input + Cmd/Ctrl+K shortcut
 *   - SyncSplitButton   — primary sync action (publish / push / pull /
 *                         sync / up-to-date) with a state-aware dropdown
 *   - BranchMenu        — secondary branch-op menu (merge, rebase,
 *                         rename, delete, rewind)
 *
 * Anything still inline here is coupled specifically to the header
 * layout rather than a reusable slice: the merge-into picker (triggered
 * by BranchMenu) and the undo/rewind popover both anchor off the header
 * right cluster, so keeping their markup here lets them share the
 * `header-right` position: relative anchor without plumbing portals.
 */
import { ref, computed, inject, watch, onMounted, onUnmounted, type Ref } from "vue";
import type { Theme } from "../composables/useTheme";
import type { GitBranch } from "../utils/backend";
import { branchSort } from "../utils/branchSort";
import { useI18n } from "../composables/useI18n";
import { useUndoStack, type UndoEntry, type UndoOpType } from "../composables/useUndoStack";
import {
  MERGE_POPOVER_REQUEST_KEY,
  UNDO_POPOVER_REQUEST_KEY,
} from "../composables/branchPickerBridge";
import RepoTabStrip from "./header/RepoTabStrip.vue";
import HeaderLogo from "./header/HeaderLogo.vue";
import BranchSelector from "./header/BranchSelector.vue";
import SyncSplitButton from "./header/SyncSplitButton.vue";
import BranchMenu from "./header/BranchMenu.vue";
import SearchTrigger from "./header/SearchTrigger.vue";
import type { RepoTab } from "../composables/useRepoTabs";

const { t } = useI18n();
const askConfirm = inject<(options: any) => Promise<boolean>>("askConfirm");

const props = defineProps<{
  hasFiles: boolean;
  theme: Theme;
  branchDisplay: string;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number; added: number; modified: number; deleted: number; renamed: number };
  hasRepo: boolean;
  /** Kept for compat — no longer rendered directly, but handy for callers. */
  folderName: string;
  canPush: boolean;
  canPull: boolean;
  /** True when the current branch has no upstream (first push will publish it). */
  needsPublish?: boolean;
  aheadCount: number;
  behindCount: number;
  /** Number of commits current HEAD is ahead of main (for action gating). */
  mainCommitCount?: number;
  /** Push remote when it differs from upstream (fork / triangular workflow). */
  pushRemote?: string | null;
  /** Commits ahead of the push remote (fork setup). */
  aheadPushCount?: number;
  isPushing: boolean;
  isPulling: boolean;
  /** Whether a rebase or reset just happened — makes Force Push primary. */
  forcePushPreferred: boolean;
  /** Whether a fetch is in flight (drives the sync-split spinner). */
  isFetching?: boolean;
  /** True when the device has no network connectivity. */
  isOffline?: boolean;
  // Branch popover
  branches: GitBranch[];
  worktreeBranches?: Set<string>;
  branchesLoading: boolean;
  isSwitchingBranch: boolean;
  isMerging: boolean;
  /** Path to the current repository (for merge preview). */
  cwd: string;
  // Tabs (repo strip)
  tabs: RepoTab[];
  activeTabId: number | null;
  /** Number of accumulated errors; drives the badge on the settings button. */
  errorCount?: number;
  /** Stash entry count — drives the badge on the Stash button. */
  stashCount?: number;
  /** Current main-content view — drives the active state of the Launchpad button. */
  activeView?: string;
}>();

const emit = defineEmits<{
  // ── Repo & tab management ────────────────────────────────────
  openFolder: [];
  openRepo: [path: string];
  switchTab: [tabId: number];
  closeTab: [tabId: number];
  newTab: [];
  openClone: [];
  openFork: [];
  reorderTabs: [oldIndex: number, newIndex: number];
  // ── Sync / publish actions ───────────────────────────────────
  push: [];
  pull: [];
  fetch: [];
  sync: [];
  publish: [];
  rebaseOntoRemote: [];
  mergeRemote: [];
  forcePush: [];
  // ── Branch actions ───────────────────────────────────────────
  switchBranch: [name: string];
  createBranch: [name: string];
  /**
   * Raised by BranchSelector's per-item delete — no type-name guard here
   * because the popover-driven list already isolates the action. The
   * current-branch delete goes through `openDeleteModal` instead (see
   * BranchDeleteModal for the guard UX).
   */
  deleteBranch: [name: string];
  /** User chose "Rename current branch" in BranchMenu — open the modal. */
  openRenameModal: [];
  /** User chose "Delete current branch" in BranchMenu — open the modal. */
  openDeleteModal: [];
  mergeBranch: [name: string];
  loadBranches: [];
  // ── Other overlays ───────────────────────────────────────────
  openRebase: [];
  openWorktrees: [branch?: string];
  openSubmodules: [];
  /** Navigate the Git Tree into a submodule (v2.15.1). */
  openSubmodule: [path: string];
  openSettings: [];
  openLogs: [];
  openSearch: [];
  undoPerformed: [];
  toggleTheme: [];
  openHelp: [];
  openStash: [];
  openTags: [];
  openLaunchpad: [];
  openAgents: [];
  discardAll: [];
  changeView: [mode: 'dashboard' | 'changes' | 'history' | 'prs' | 'launchpad'];
}>();

// ─── Merge-into picker popover (triggered by BranchMenu) ──────────
const showMergePopover = ref(false);
const mergeFilter = ref("");

function openMergePopover() {
  showMergePopover.value = true;
  mergeFilter.value = "";
  emit("loadBranches");
}

function closeMergePopover() {
  showMergePopover.value = false;
}

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

// ─── Undo / rewind popover (triggered by BranchMenu.rewind) ───────
const undoStack = useUndoStack();
const showUndoPopover = ref(false);

function openUndoPopover() {
  showUndoPopover.value = true;
  if (props.cwd) undoStack.refresh(props.cwd);
}

function closeUndoPopover() {
  showUndoPopover.value = false;
}

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

function isHardUndo(entry: UndoEntry): boolean {
  return entry.type !== "commit" && entry.type !== "amend";
}

async function handleUndo(entry: UndoEntry) {
  const msg = isHardUndo(entry)
    ? t("undoStack.undoHardConfirm")
    : t("undoStack.undoConfirm");
  
  if (askConfirm) {
    if (!await askConfirm({
      title: t("undoStack.undoTitle"),
      message: msg,
      confirmLabel: t("undoStack.undoButton"),
      danger: isHardUndo(entry),
    })) return;
  } else {
    // eslint-disable-next-line no-alert
    if (!confirm(msg)) return;
  }

  try {
    await undoStack.undo(props.cwd, entry);
    closeUndoPopover();
    emit("undoPerformed");
  } catch {
    // lastError is set by the composable — shown in the popover.
  }
}

watch(
  () => props.cwd,
  (cwd) => {
    if (cwd) undoStack.refresh(cwd);
  },
  { immediate: true },
);

// ─── External triggers (native menu → popovers) ─────────────────────
// Counter-bump pattern: each ++ reopens the target popover. Lets the
// macOS menu's Repository → Merge… and Undo Last Operation… items pop
// the same UI the BranchMenu would, without lifting the popover state
// up to App.vue.
const mergeRequestCounter = inject<Ref<number> | null>(MERGE_POPOVER_REQUEST_KEY, null);
const undoRequestCounter = inject<Ref<number> | null>(UNDO_POPOVER_REQUEST_KEY, null);
if (mergeRequestCounter) {
  watch(mergeRequestCounter, () => openMergePopover());
}
if (undoRequestCounter) {
  watch(undoRequestCounter, () => openUndoPopover());
}

// ─── BranchMenu event handlers ─────────────────────────────────────
function onBranchMenuMerge() {
  openMergePopover();
}
function onBranchMenuRebase() {
  emit("openRebase");
}
// Rename + delete of the current branch both go through modals owned by
// App.vue — we just forward the "open the modal" signal. The confirm paths
// (actual git call) live in App.vue where the composables are in scope.
function onBranchMenuRename() {
  emit("openRenameModal");
}
function onBranchMenuDelete() {
  emit("openDeleteModal");
}
function onBranchMenuRewind() {
  openUndoPopover();
}

// ─── Close popovers on click outside ──────────────────────────────
// BranchSelector owns its own click-outside handling now; we only need
// to manage the two popovers anchored in the right cluster here.
function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (showMergePopover.value && !target.closest(".merge-popover-anchor")) {
    closeMergePopover();
  }
  if (showUndoPopover.value && !target.closest(".undo-popover-anchor")) {
    closeUndoPopover();
  }
}

onMounted(() => document.addEventListener("click", onDocClick, true));
onUnmounted(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <header class="app-header">
    <!-- ── Row 1: Logo + Repo tabs + top-right buttons ─────── -->
    <div class="app-header__tabs">
      <HeaderLogo />
      <div v-if="tabs.length >= 1" class="header-separator header-separator--left" aria-hidden="true"></div>
      <RepoTabStrip
        v-if="tabs.length >= 1"
        :tabs="tabs"
        :active-tab-id="activeTabId"
        @switch-tab="(id) => emit('switchTab', id)"
        @close-tab="(id) => emit('closeTab', id)"
        @new-tab="emit('newTab')"
        @open-clone="emit('openClone')"
        @open-fork="emit('openFork')"
        @open-recent="(path) => emit('openRepo', path)"
        @reorder-tabs="(oldIdx, newIdx) => emit('reorderTabs', oldIdx, newIdx)"
      />

      <div class="app-header__tabs-spacer"></div>

      <!-- Offline indicator pill (top-right, before Workspace) -->
      <template v-if="isOffline">
        <div class="header-separator header-separator--offline" aria-hidden="true"></div>
        <div class="offline-pill" :title="t('offline.tooltip')">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 2l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M9.5 4.5A6 6 0 0114 10M4.1 6.5A6 6 0 003 10M6.5 9.5A2 2 0 019.5 12M8 14v.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <span>{{ t('offline.label') }}</span>
        </div>
        <div class="header-separator header-separator--offline" aria-hidden="true"></div>
      </template>

      <!-- Primary destinations — labeled pills so they stand out from the
           utility icons (theme / help / settings) that follow the divider. -->
      <template v-if="hasRepo">
        <button
          class="btn btn--secondary header-feature-btn"
          :class="{ 'btn--feature-active': activeView === 'launchpad' }"
          v-tooltip="t('launchpad.openTooltip')"
          :aria-label="t('launchpad.openTooltip')"
          :aria-pressed="activeView === 'launchpad'"
          @click="emit('openLaunchpad')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 16.5c-1.5 1-2 4-2 4s3-.5 4-2c.6-.85.5-2 .5-2"/>
            <path d="M12 15l-3-3a11 11 0 0 1 7-9c2.5 0 4 1.5 4 4a11 11 0 0 1-9 7l1 1z"/>
            <path d="M9 12H5s.5-2.5 2-3.5c1.3-.85 3-.5 3-.5"/>
            <path d="M12 15v4s2.5-.5 3.5-2c.85-1.3.5-3 .5-3"/>
            <circle cx="15" cy="9" r="1.2"/>
          </svg>
          <span>{{ t('launchpad.title') }}</span>
        </button>

        <button
          class="btn btn--secondary header-feature-btn"
          v-tooltip="t('agents.sidebarTooltip')"
          :aria-label="t('agents.title')"
          @click="emit('openAgents')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M12 2v4M8 11V9a4 4 0 0 1 8 0v2"/>
            <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none"/>
            <path d="M9 20h6"/>
          </svg>
          <span>{{ t('agents.headerLabel') }}</span>
        </button>

        <div class="header-separator" aria-hidden="true"></div>
      </template>

      <!-- Theme toggle -->
      <button
        class="btn btn--icon theme-toggle"
        :aria-label="theme === 'dark' ? t('header.themeLight') : t('header.themeDark')"
        v-tooltip="theme === 'dark' ? t('header.themeLightLabel') : t('header.themeDarkLabel')"
        @click="emit('toggleTheme')"
      >
        <svg v-if="theme === 'dark'" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <svg v-else width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M14 9.3A6 6 0 016.7 2 6 6 0 1014 9.3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- Help -->
      <button
        class="btn btn--icon"
        :aria-label="t('header.openHelp')"
        v-tooltip="t('header.openHelp')"
        @click="emit('openHelp')"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 11v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <path d="M8 5.5c1 0 1.8.8 1.8 1.8S9 8.6 8 8.6V9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- Settings -->
      <div class="settings-btn-wrap">
        <button
          class="btn btn--icon"
          :aria-label="t('settings.title')"
          v-tooltip="t('settings.title')"
          @click="emit('openSettings')"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="5.5" cy="4" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2" />
            <circle cx="10.5" cy="8" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2" />
            <circle cx="7" cy="12" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
        <button
          v-if="(props.errorCount ?? 0) > 0"
          type="button"
          class="settings-error-dot"
          v-tooltip="t('statusBar.errorsTooltip', props.errorCount ?? 0)"
          :aria-label="t('statusBar.errorsTooltip', props.errorCount ?? 0)"
          @click.stop="emit('openLogs')"
        >{{ (props.errorCount ?? 0) > 99 ? '99+' : props.errorCount }}</button>
      </div>
    </div>

    <!-- ── Row 2: Main action row ───────────────────────────── -->
    <div class="app-header__row">
      <!-- Left cluster: branch selector + sync + branch actions -->
      <div class="header-left">
        <!-- Fallback: "Open" button when no repo is open -->
        <button
          v-if="!hasRepo"
          class="folder-trigger"
          @click="emit('openFolder')"
          :title="t('header.openFolder')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none" />
          </svg>
          <span class="folder-name">{{ t('header.open') }}</span>
        </button>

        <template v-if="hasRepo">
          <!-- Branch selector: trigger chip + popover, extracted component. -->
          <BranchSelector
            :branch-display="branchDisplay"
            :repo-stats="repoStats"
            :branches="branches"
            :worktree-branches="worktreeBranches"
            :branches-loading="branchesLoading"
            :is-switching-branch="isSwitchingBranch"
            :cwd="cwd"
            @switch-branch="(name) => emit('switchBranch', name)"
            @create-branch="(name) => emit('createBranch', name)"
            @delete-branch="(name) => emit('deleteBranch', name)"
            @open-worktrees="(branch) => emit('openWorktrees', branch)"
            @load-branches="emit('loadBranches')"
            @change-view="(mode) => emit('changeView', mode)"
            @open-submodule="(path) => emit('openSubmodule', path)"
          />

          <!-- BranchMenu + its two piggy-backed popovers.
               The popovers anchor on their own wrappers so the click-outside
               rules can target them precisely. header-left is position:relative
               so they drop below the row from the left edge. -->
          <BranchMenu
            :current-branch="branchDisplay"
            :disabled="isMerging || isSwitchingBranch"
            :has-changes="hasFiles"
            :main-commit-count="mainCommitCount"
            @open-merge-picker="onBranchMenuMerge"
            @open-rebase-picker="onBranchMenuRebase"
            @open-rename-modal="onBranchMenuRename"
            @open-delete-modal="onBranchMenuDelete"
            @open-rewind="onBranchMenuRewind"
            @discard-all="emit('discardAll')"
          />

          <SyncSplitButton
            :ahead-count="aheadCount"
            :behind-count="behindCount"
            :push-remote="pushRemote"
            :ahead-push-count="aheadPushCount"
            :needs-publish="needsPublish ?? false"
            :is-pushing="isPushing"
            :is-pulling="isPulling"
            :force-push-preferred="forcePushPreferred"
            :is-fetching="isFetching ?? false"
            :can-push="canPush"
            :can-pull="canPull"
            :is-offline="isOffline"
            @push="emit('push')"
            @pull="emit('pull')"
            @sync="emit('sync')"
            @fetch="emit('fetch')"
            @publish="emit('publish')"
            @rebase-onto-remote="emit('rebaseOntoRemote')"
            @merge-remote="emit('mergeRemote')"
            @force-push="emit('forcePush')"
          />

          <!-- Stash button -->
          <div class="header-action-sep" aria-hidden="true"></div>
          <button
            class="btn btn--secondary header-action-btn"
            :title="t('stash.title')"
            :aria-label="t('stash.title')"
            @click="emit('openStash')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 8v13H3V8"/>
              <path d="M1 3h22v5H1z"/>
              <path d="M10 12h4"/>
            </svg>
            <span>{{ t('stash.title') }}</span>
            <span v-if="(stashCount ?? 0) > 0" class="header-action-btn__count">{{ stashCount }}</span>
          </button>

          <!-- Tags button -->
          <button
            class="btn btn--secondary header-action-btn"
            :title="t('tags.title')"
            :aria-label="t('tags.title')"
            @click="emit('openTags')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 2h6l6 6-6 6-6-6V2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
              <circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/>
            </svg>
            <span>{{ t('tags.title') }}</span>
          </button>

          <!-- Worktrees button -->
          <button
            class="btn btn--secondary header-action-btn"
            :title="t('worktree.title')"
            :aria-label="t('worktree.title')"
            @click="emit('openWorktrees')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none" />
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none" />
              <rect x="5.5" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none" />
              <path d="M4.5 7v1.5M11.5 7v1.5M4.5 8.5h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <span>{{ t('worktree.title') }}</span>
          </button>

          <!-- Submodules button -->
          <button
            class="btn btn--secondary header-action-btn"
            :title="t('submodule.title')"
            :aria-label="t('submodule.title')"
            @click="emit('openSubmodules')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none" />
              <rect x="6" y="6" width="4" height="4" rx="0.5" stroke="currentColor" stroke-width="1.3" fill="none" />
            </svg>
            <span>{{ t('submodule.title') }}</span>
          </button>

          <!-- Merge-into picker (triggered by BranchMenu → onBranchMenuMerge) -->
          <div v-if="showMergePopover" class="merge-popover-anchor">
            <div class="merge-popover">
              <div class="mp-header">
                <input
                  v-model="mergeFilter"
                  class="mp-filter"
                  :placeholder="t('header.mergeFilterPlaceholder')"
                  autofocus
                  @keydown.escape="closeMergePopover"
                />
              </div>
              <div v-if="branchesLoading" class="mp-loading">
                <div class="mp-spinner"></div>
              </div>
              <div v-else class="mp-list-wrapper">
                <ul v-if="mergeBranches.length > 0" class="mp-list">
                  <li
                    v-for="branch in mergeBranches"
                    :key="branch.name"
                    class="mp-item"
                    :class="{ 'mp-item--remote': branch.isRemote }"
                    @click="handleMerge(branch.name)"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3" />
                      <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3" />
                      <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3" />
                      <path d="M5 6v4M10 8H7c-1.1 0-2-.9-2-2" stroke="currentColor" stroke-width="1.3" />
                    </svg>
                    <svg v-if="props.worktreeBranches?.has(branch.name)" class="branch-wt-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-left: 2px; color: var(--color-success); flex-shrink: 0;">
                      <circle cx="8" cy="4.5" r="2.5" />
                      <circle cx="4.5" cy="8.5" r="2.5" />
                      <circle cx="11.5" cy="8.5" r="2.5" />
                      <rect x="7.5" y="8" width="1" height="6" />
                    </svg>
                    <span class="mp-item-name mono">{{ branch.name }}</span>
                    <span v-if="branch.isRemote" class="mp-item-tag">remote</span>
                  </li>
                </ul>
                <div v-else class="mp-empty">
                  <span class="muted">{{ t('branches.noBranch') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Undo / rewind popover (triggered by BranchMenu → rewind) -->
          <div v-if="showUndoPopover" class="undo-popover-anchor">
            <div class="undo-popover">
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
                    :title="t('undoStack.undoButton')"
                    @click="handleUndo(entry)"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.4" fill="none" />
                      <path d="M9 6.4V9l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M3.5 3v3.5H7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M3.5 6.5A6 6 0 019 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" />
                    </svg>
                  </button>
                </li>
              </ul>
              <div v-else class="undo-empty">{{ t('undoStack.noHistory') }}</div>
            </div>
          </div>
        </template>
      </div>

      <SearchTrigger v-if="hasRepo" class="header-search" @open-search="emit('openSearch')" />

    </div>
  </header>
</template>

<style scoped>
/* ─── Header shell ─────────────────────────────────────── */
.app-header {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.app-header__tabs {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-5);
  min-height: var(--tabbar-height);
  border-bottom: 1px solid var(--color-border);
  box-sizing: border-box;
  overflow: hidden;
}

.app-header__tabs-spacer {
  flex: 1;
}

.app-header__row {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  height: var(--header-height);
  padding: 0 var(--space-6);
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
  position: relative; /* anchor for merge + undo popovers */
}

.header-search {
  margin-left: auto;
}

.header-action-sep {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  flex-shrink: 0;
  margin-inline: var(--space-1);
}

.header-action-btn {
  min-height: 37px;
}

.header-left :deep(.branch-trigger),
.header-left :deep(.btn--sync) {
  min-height: 37px;
}

.header-action-btn__count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  line-height: 16px;
  text-align: center;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-radius: var(--radius-pill);
  font-variant-numeric: tabular-nums;
}

.header-separator {
  width: 1px;
  height: 20px;
  background: var(--color-border);
  flex-shrink: 0;
  margin-inline: var(--space-2);
}

/* ─── "Open" button when no repo is loaded ─────────────── */
.folder-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-md);
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

/* ─── Generic header button styles ─────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-md);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  transition: background var(--transition-base), color var(--transition-base), transform var(--transition-fast);
  white-space: nowrap;
}
.btn:active:not(:disabled) { transform: translateY(1px); }
/* `.btn:disabled` opacity comes from the global rule in main.css (0.4). */

.btn--secondary { background: var(--color-bg-tertiary); color: var(--color-text); }
.btn--secondary:hover:not(:disabled) { background: var(--color-border); }

/* Header feature pills (Launchpad / Workspace / Agents) — labeled, slightly
   tighter than row-2 actions, with an accent active state for the open view. */
.header-feature-btn {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-sm);
}
.header-feature-btn svg { flex-shrink: 0; opacity: 0.85; }
.btn--feature-active,
.btn--feature-active:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.btn--feature-active svg { opacity: 1; }

.btn--primary { background: var(--color-accent); color: var(--color-accent-text); }
.btn--primary:hover:not(:disabled) { background: var(--color-accent-hover); }

/*
 * BranchMenu is a SECONDARY action, so demote its trigger to neutral.
 * Selector moved to header-left since BranchMenu now lives there.
 */
.header-left :deep(.branch-menu__trigger) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
.header-left :deep(.branch-menu__trigger:hover:not(:disabled)) {
  background: var(--color-border);
}

.btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  transition: background var(--transition-base), color var(--transition-base);
}
.btn--icon:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
.btn--icon:disabled,
.btn--disabled { opacity: 0.35; cursor: not-allowed; }

.btn-spinner { animation: spin 0.7s linear infinite; }

@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Merge-into picker popover ────────────────────────── */
.merge-popover-anchor {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: var(--space-3);
  z-index: 50;
}

.merge-popover {
  width: 300px;
  max-height: 360px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  animation: mpSlide var(--transition-slow);
  overflow: hidden;
}

@keyframes mpSlide {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
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
  background: #ffffff;
  color: #000000;
  text-shadow: none;
}

.mp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-7);
  font-size: var(--font-size-base);
}

/* ─── Undo / rewind popover ────────────────────────────── */
.undo-popover-anchor {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: var(--space-3);
  z-index: 50;
}

.undo-popover {
  width: 340px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
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
.undo-entry:last-child { border-bottom: none; }
.undo-entry:hover { background: var(--color-bg-tertiary); }

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

.undo-entry-date { font-size: var(--font-size-xs); }

.undo-entry-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  /* Surface token : #ffffff en Light (sur fond popover #f4f4f8) et
     #15151f en Dark (sur fond popover #0d0d13). Évite le fond
     transparent qui ne contraste pas en mode clair. */
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-base), background var(--transition-base), border-color var(--transition-base);
}
.undo-entry:hover .undo-entry-btn { opacity: 1; }
.undo-entry-btn:hover {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}
.undo-entry-btn--hard { color: var(--color-warning); }
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

/* ─── Settings error dot ─────────────────────────────── */
.settings-btn-wrap {
  position: relative;
  display: inline-flex;
}

.settings-error-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--color-danger, #f38ba8);
  border: 1.5px solid var(--color-bg-secondary);
  color: #fff;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform var(--transition-fast);
}

.settings-error-dot:hover {
  transform: scale(1.1);
}

/* ─── Offline pill (in top-right tab bar) ────────────── */
.offline-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  user-select: none;
  flex-shrink: 0;
}

.header-separator--offline {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  flex-shrink: 0;
  margin-inline: var(--space-1);
}
</style>
