<script setup lang="ts">
/**
 * BranchSelector — branch-chip trigger + popover (local/remote branches,
 * filter, create form with optional AI naming, per-item actions, and a
 * nested MergePreviewPanel).
 *
 * Previously lived inline inside `AppHeader.vue`; extracted in task #7
 * to keep the header file readable and to give the branch-picker a
 * clean surface for future work (keyboard nav, "branches view", etc.).
 *
 * Layout (trigger)
 * ────────────────
 * Line 1 — branch icon + branch name + chevron
 * Line 2 — inline stats (staged / modified / untracked / conflicts)
 *
 * The 2-line layout lets us keep the dirty-state context attached to
 * the branch chip rather than splitting it into a separate group. When
 * there are no stats to show, the chip collapses to a single line.
 *
 * Click-outside
 * ─────────────
 * Owned here (not by the parent) — when the component is mounted,
 * popover lifecycle is self-contained. The handler uses `.closest()`
 * against the wrapper class on this component's root, so clicks on
 * either the trigger OR the popover count as "inside".
 */
import { ref, computed, inject, onMounted, onUnmounted, watch, defineAsyncComponent, type Ref } from "vue";
import { gitSubmoduleList, gitSubmoduleBranches, getGitLog, type GitBranch, type SubmoduleEntry, type SubmoduleBranch } from "../../utils/backend";
import { branchSort } from "../../utils/branchSort";
import { useI18n } from "../../composables/useI18n";
import type { LocaleKey } from "../../locales";
import { useMergePreview, type PreviewOperation } from "../../composables/useMergePreview";
import { useScratchWorktree } from "../../composables/useScratchWorktree";
import { useRepoTabs } from "../../composables/useRepoTabs";
import { useAIProvider } from "../../composables/useAIProvider";
import { useBranchName } from "../../composables/useBranchName";
import { usePinnedBranches } from "../../composables/usePinnedBranches";
import { useArchivedBranches } from "../../composables/useArchivedBranches";
import { BRANCH_CREATE_REQUEST_KEY } from "../../composables/branchPickerBridge";
// Lazy: the merge-preview panel only mounts when the user expands a branch's
// preview row inside the (already v-if'd) popover. BranchSelector is eager via
// AppHeader, so importing this 600-line panel statically would pin it in main.
const MergePreviewPanel = defineAsyncComponent(() => import("../MergePreviewPanel.vue"));
import BaseModal from "../BaseModal.vue";
// Lazy too — only mounted inside the v-if'd create-branch modal.
const BranchNameField = defineAsyncComponent(() => import("../BranchNameField.vue"));

const { t } = useI18n();

const props = defineProps<{
  branchDisplay: string;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number; added: number; modified: number; deleted: number; renamed: number };
  branches: GitBranch[];
  worktreeBranches?: Set<string>;
  branchesLoading: boolean;
  isSwitchingBranch: boolean;
  /** Path to the current repository (for merge preview). */
  cwd: string;
  }>();

  const currentBranchName = computed(() => {
  return props.branches.find((b) => b.isCurrent)?.name;
  });

  const isCurrentBranchWorktree = computed(() => {
  const name = currentBranchName.value;
  return name && props.worktreeBranches ? props.worktreeBranches.has(name) : false;
  });

  const emit = defineEmits<{  switchBranch: [name: string];
  createBranch: [name: string];
  deleteBranch: [name: string];
  openWorktrees: [branch?: string];
  loadBranches: [];
  changeView: [mode: 'changes'];
  /** Navigate the Git Tree into a submodule (v2.15.1). Payload is the submodule path relative to cwd. */
  openSubmodule: [path: string];
}>();

// Whether the working tree has anything worth reporting — drives the
// stats line inside the trigger. Conflicts count as "stats" too since
// that's the most urgent state and should surface in the chip.
const hasRepoStats = computed(
  () =>
    props.repoStats.staged +
      props.repoStats.unstaged +
      props.repoStats.untracked +
      props.repoStats.conflicted >
    0,
);

/**
 * Pick the singular or plural label for a stat based on the count.
 *
 * The four stats kinds map to `header.<kind>` (plural) and
 * `header.<kind>One` (singular). Some languages inflect the participle
 * ("modifié" / "modifiés" in FR); others use the same form for both
 * ("modified" in EN, "已修改" in zh-CN) — the singular keys carry the
 * right value regardless, so the callsite doesn't have to know which.
 */
type StatKind = "staged" | "modified" | "untracked" | "conflicts";
function statLabel(kind: StatKind, n: number): string {
  const key = (`header.${kind}${n === 1 ? "One" : ""}`) as LocaleKey;
  return t(key);
}

// ─── Popover state ───────────────────────────────────────────────
const showPopover = ref(false);
const branchFilter = ref("");
const showCreate = ref(false);
const newBranchName = ref("");

// Collapsible LOCAL / REMOTE sections — open by default, toggled via
// their section headers (same affordance as the submodules section).
const showLocal = ref(true);
const showRemote = ref(true);

// External create-form trigger (currently used by the native macOS menu's
// "New Branch…" item). Each bump of the injected counter opens the popover
// and the inline create form. The input's `autofocus` does the rest.
const createRequest = inject<Ref<number> | null>(BRANCH_CREATE_REQUEST_KEY, null);
if (createRequest) {
  watch(createRequest, () => {
    showPopover.value = true;
    showCreate.value = true;
    branchFilter.value = "";
    newBranchName.value = "";
    emit("loadBranches");
  });
}

const ai = useAIProvider();
const {
  isGenerating: isGeneratingBranchName,
  suggest: suggestBranchName,
  lastError: branchNameAiError,
} = useBranchName();

async function handleBranchNameAI() {
  try {
    const suggestion = await suggestBranchName(props.cwd, newBranchName.value);
    if (suggestion) newBranchName.value = suggestion;
  } catch {
    // Surfaced via branchNameAiError ref in the template
  }
}

function togglePopover() {
  showPopover.value = !showPopover.value;
  if (showPopover.value) {
    branchFilter.value = "";
    emit("loadBranches");
    void loadSubmodules();
  }
}

/** Close the create form and clear its draft name. */
function resetCreate() {
  showCreate.value = false;
  newBranchName.value = "";
}

function closePopover() {
  showPopover.value = false;
  resetCreate();
}

function openCreate() {
  newBranchName.value = "";
  showCreate.value = true;
}

function cancelCreate() {
  resetCreate();
}

// ─── Submodules section (v2.15.1) ────────────────────────────────
const submodules = ref<SubmoduleEntry[]>([]);
const showSubmodules = ref(false);
const expandedSubmodule = ref<string | null>(null);
const submoduleBranches = ref<Record<string, SubmoduleBranch[]>>({});

async function loadSubmodules() {
  try {
    submodules.value = await gitSubmoduleList(props.cwd);
  } catch {
    submodules.value = [];
  }
}

async function toggleSubmoduleExpand(path: string) {
  if (expandedSubmodule.value === path) {
    expandedSubmodule.value = null;
    return;
  }
  expandedSubmodule.value = path;
  if (!submoduleBranches.value[path]) {
    try {
      submoduleBranches.value[path] = await gitSubmoduleBranches(props.cwd, path);
    } catch {
      submoduleBranches.value[path] = [];
    }
  }
}

function openSubmoduleTree(path: string) {
  emit("openSubmodule", path);
  closePopover();
}

// ─── Archived branches (relocated from the Dashboard sidebar, v3) ──
const archives = useArchivedBranches(() => props.cwd);
const showArchived = ref(false);
const archivedBranchList = computed(() => {
  const byName = new Map(props.branches.filter((b) => !b.isRemote).map((b) => [b.name, b]));
  return archives.archived.value
    .map((name) => byName.get(name))
    .filter((b): b is GitBranch => !!b)
    .filter((b) => !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()));
});
function toggleArchive(name: string) {
  if (archives.isArchived(name)) archives.unarchive(name);
  else archives.archive(name);
}

const localBranches = computed(() =>
  props.branches
    .filter((b) => !b.isRemote)
    // Archived branches are hidden from the main list (shown in their own
    // collapsible section), but the current branch is always visible.
    .filter((b) => b.isCurrent || !archives.isArchived(b.name))
    .filter((b) => !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()))
    .sort(branchSort),
);

const remoteBranches = computed(() =>
  props.branches
    .filter((b) => b.isRemote)
    .filter((b) => !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()))
    .sort(branchSort),
);

// ─── Pinned branches (relocated from the Dashboard sidebar, v3) ──
const pins = usePinnedBranches(() => props.cwd);
/** Pinned local branches, in pin order, filtered by the search box. */
const pinnedBranches = computed(() => {
  const byName = new Map(props.branches.filter((b) => !b.isRemote).map((b) => [b.name, b]));
  return pins.pinned.value
    .map((name) => byName.get(name))
    .filter((b): b is GitBranch => !!b)
    .filter((b) => !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()));
});
function togglePin(name: string) {
  if (pins.isPinned(name)) pins.unpin(name);
  else pins.pin(name);
}

function handleBranchSwitch(name: string) {
  emit("switchBranch", name);
  closePopover();
}

function handleBranchCreate() {
  const name = newBranchName.value.trim();
  if (!name) return;
  emit("createBranch", name);
  closePopover();
}

// ─── Merge Preview (inside popover) ──────────────────────────────
const {
  loading: previewLoading,
  error: previewError,
  summary: previewSummary,
  conflictingFiles: previewConflicts,
  riskLevel: previewRisk,
  computePreview,
  reset: resetPreview,
} = useMergePreview(() => props.cwd);

const previewingBranch = ref<string | null>(null);
const previewOperation = ref<PreviewOperation>("merge");

// ─── Commit picker (cherry-pick) ─────────────────────────────────
// When the user selects cherry-pick as the preview operation, we need to
// pick a specific commit SHA — not a branch tip — because git cherry-pick
// operates on individual commits.

interface CommitShortEntry {
  sha: string;
  shortSha: string;
  message: string;
}

const cherryPickCommits = ref<CommitShortEntry[]>([]);
const cherryPickCommitsLoading = ref(false);
const selectedCherryPickSha = ref<string | null>(null);

async function loadCherryPickCommits(branchName: string): Promise<void> {
  cherryPickCommitsLoading.value = true;
  cherryPickCommits.value = [];
  selectedCherryPickSha.value = null;
  try {
    const entries = await getGitLog(props.cwd, 20, false, undefined, undefined, branchName);
    cherryPickCommits.value = entries.map((e) => ({
      sha: e.hashFull,
      shortSha: e.hash,
      message: e.message,
    }));
    if (cherryPickCommits.value.length > 0) {
      selectedCherryPickSha.value = cherryPickCommits.value[0].sha;
    }
  } catch {
    cherryPickCommits.value = [];
  } finally {
    cherryPickCommitsLoading.value = false;
  }
}

// ─── Scratch worktree (v2.20.0) ──────────────────────────────────
// Lets the user spin up an isolated worktree to resolve the previewed
// conflicts away from the active checkout, then bring the result back
// in one click (or discard it). State + errors are surfaced in the panel.
const {
  active: scratchActive,
  loading: scratchLoading,
  error: scratchError,
  originCwd: scratchOriginCwd,
  create: createScratch,
  mergeBack: scratchMergeBack,
  discard: scratchDiscard,
} = useScratchWorktree(() => props.cwd);

// Opening the scratch as a repo tab is what makes the sandbox usable: the user
// resolves the conflicts IN that tab, then comes back here to bring them across.
const { openTab, closeTab, tabs } = useRepoTabs();
// Id of the tab we opened for the active scratch, so we can close it on cleanup.
let scratchTabId: number | null = null;

async function handleResolveInScratch() {
  // Base the scratch on the branch we're previewing (the source we'd merge in),
  // falling back to the current HEAD when unknown.
  const wt = await createScratch(previewingBranch.value ?? undefined);
  if (wt) {
    // Open + switch to the isolated worktree so the user can resolve there.
    const tab = openTab(wt.path);
    scratchTabId = tab.id;
  }
}

/** Remove the dead scratch tab once its worktree has been merged back / discarded. */
function closeScratchTab() {
  if (scratchTabId !== null && tabs.value.some((t) => t.id === scratchTabId)) {
    closeTab(scratchTabId);
  }
  scratchTabId = null;
}

async function handleScratchMergeBack() {
  // Switch back to the origin checkout BEFORE merge-back removes the scratch dir,
  // so the UI stops watching a directory that is about to disappear.
  if (scratchOriginCwd.value) openTab(scratchOriginCwd.value);
  const ok = await scratchMergeBack();
  if (ok) closeScratchTab();
}

async function handleScratchDiscard() {
  if (scratchOriginCwd.value) openTab(scratchOriginCwd.value);
  const ok = await scratchDiscard();
  if (ok) closeScratchTab();
}

async function togglePreview(branchName: string) {
  if (previewingBranch.value === branchName) {
    previewingBranch.value = null;
    resetPreview();
    cherryPickCommits.value = [];
    selectedCherryPickSha.value = null;
    return;
  }
  previewingBranch.value = branchName;
  previewOperation.value = "merge";
  await computePreview(branchName, previewOperation.value);
}

// Re-run the predictor for the same target when the user switches operation.
async function changePreviewOperation(op: PreviewOperation) {
  previewOperation.value = op;
  if (!previewingBranch.value) return;

  if (op === "cherry-pick") {
    // Load the commit list for this branch; preview fires after user picks a commit.
    await loadCherryPickCommits(previewingBranch.value);
    // Auto-run preview with the first commit if available.
    if (selectedCherryPickSha.value) {
      await computePreview(selectedCherryPickSha.value, "cherry-pick");
    }
  } else {
    await computePreview(previewingBranch.value, op);
  }
}

/** Called when the user picks a different commit in the cherry-pick commit selector. */
async function onCherryPickCommitChange(sha: string): Promise<void> {
  selectedCherryPickSha.value = sha;
  await computePreview(sha, "cherry-pick");
}

function closePreview() {
  previewingBranch.value = null;
  resetPreview();
  cherryPickCommits.value = [];
  selectedCherryPickSha.value = null;
}

// ─── Click-outside to close ──────────────────────────────────────
// Attached to the document once at mount; cleaned up on unmount. We
// use `.closest('.branch-popover-wrapper')` so clicks on either the
// trigger or the popover count as "inside" (both live under that
// wrapper root).
function onDocClick(e: MouseEvent) {
  if (!showPopover.value) return;
  // The new-branch modal teleports to <body>, outside the wrapper. Keep the
  // popover open while it's up — the modal owns its own backdrop dismissal.
  if (showCreate.value) return;
  const target = e.target as HTMLElement | null;
  if (!target?.closest(".branch-popover-wrapper")) {
    closePopover();
  }
}

onMounted(() => document.addEventListener("click", onDocClick, true));
onUnmounted(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <div class="branch-popover-wrapper">
    <!--
      2-line layout:
        Line 1 — branch icon + branch name + chevron
        Line 2 — inline stats (staged / modified / untracked / conflicts)
      When stats are absent, the chip collapses to a single line via
      the `branch-trigger--with-stats` modifier being dropped.
    -->
    <div class="branch-trigger-group">
    <button
      class="branch-trigger"
      :class="{
        'branch-trigger--loading': isSwitchingBranch,
        'branch-trigger--with-stats': hasRepoStats,
      }"
      :title="branchDisplay"
      @click="togglePopover"
    >
      <svg v-if="isSwitchingBranch" class="btn-spinner branch-trigger__icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3" />
        <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
      </svg>
      <svg v-else class="branch-trigger__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3" />
        <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3" />
        <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3" />
        <path d="M5 6v4M7 4h3c1.1 0 2 .9 2 2v0" stroke="currentColor" stroke-width="1.3" />
      </svg>

      <span class="branch-trigger__body">
        <div class="branch-trigger__name-row">
          <svg v-if="isCurrentBranchWorktree" class="branch-wt-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 4px; color: var(--color-success);">
            <circle cx="8" cy="4.5" r="2.5" />
            <circle cx="4.5" cy="8.5" r="2.5" />
            <circle cx="11.5" cy="8.5" r="2.5" />
            <rect x="7.5" y="8" width="1" height="6" />
          </svg>
          <span class="branch-trigger__name mono">{{ branchDisplay }}</span>
          <span
            v-if="hasRepoStats"
            class="branch-trigger__changes-dot"
            :title="t('sidebar.tabChanges')"
            @click.stop="emit('changeView', 'changes')"
          ></span>
        </div>
        <span v-if="hasRepoStats" class="branch-trigger__stats">
          <span v-if="repoStats.staged > 0" class="branch-trigger__stat">
            <span class="branch-trigger__stat-dot" style="background: var(--color-success)"></span>
            {{ repoStats.staged }} {{ statLabel('staged', repoStats.staged) }}
          </span>
          <span v-if="repoStats.unstaged > 0" class="branch-trigger__stat">
            <span class="branch-trigger__stat-dot" style="background: var(--color-warning)"></span>
            {{ repoStats.unstaged }} {{ statLabel('modified', repoStats.unstaged) }}
          </span>
          <span v-if="repoStats.untracked > 0" class="branch-trigger__stat">
            <span class="branch-trigger__stat-dot" style="background: var(--color-text-muted)"></span>
            {{ repoStats.untracked }} {{ statLabel('untracked', repoStats.untracked) }}
          </span>
          <span v-if="repoStats.conflicted > 0" class="branch-trigger__stat">
            <span class="branch-trigger__stat-dot" style="background: var(--color-danger)"></span>
            {{ repoStats.conflicted }} {{ statLabel('conflicts', repoStats.conflicted) }}
          </span>
        </span>
      </span>

      <svg class="branch-chevron" :class="{ 'branch-chevron--open': showPopover }" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2.5 3.5l2.5 3 2.5-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
      <!-- Fused "new branch" button, sits flush to the right of the trigger -->
      <button class="branch-add-btn" :title="t('branches.create')" :aria-label="t('branches.create')" @click="openCreate">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div v-if="showPopover" class="branch-popover">
      <div class="bp-header">
        <input
          v-model="branchFilter"
          class="bp-filter"
          :placeholder="t('branches.filter')"
          autofocus
          @keydown.escape="closePopover"
        />
      </div>

      <div v-if="branchesLoading" class="bp-loading">
        <div class="bp-spinner"></div>
      </div>
      <div v-else class="bp-lists">
        <!-- Pinned branches (relocated from the Dashboard, v3) -->
        <div v-if="pinnedBranches.length > 0" class="bp-section">
          <div class="bp-section-toggle" style="cursor: default;">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="opacity:0.7;">
              <path d="M8 1l2 4.5 5 .5-3.7 3.3L12.5 15 8 12.3 3.5 15l1.2-5.7L1 6l5-.5z"/>
            </svg>
            <span>{{ t('sidebar.pinnedBranches') }}</span>
            <span class="bp-section-toggle__count">{{ pinnedBranches.length }}</span>
          </div>
          <ul class="bp-list">
            <li
              v-for="branch in pinnedBranches"
              :key="`pin-${branch.name}`"
              class="bp-item"
              :class="{ 'bp-item--current': branch.isCurrent }"
              @click="!branch.isCurrent && handleBranchSwitch(branch.name)"
            >
              <span v-if="branch.isCurrent" class="bp-current-dot"></span>
              <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
              <span v-if="branch.ahead > 0 || branch.behind > 0" class="bp-item-meta muted">
                <span v-if="branch.ahead > 0">&uarr;{{ branch.ahead }}</span>
                <span v-if="branch.behind > 0">&darr;{{ branch.behind }}</span>
              </span>
              <span class="bp-item-actions" @click.stop>
                <button class="bp-item-action bp-item-action--active" :title="t('branch.unpin')" @click.stop="pins.unpin(branch.name)">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 1l2 4.5 5 .5-3.7 3.3L12.5 15 8 12.3 3.5 15l1.2-5.7L1 6l5-.5z"/>
                  </svg>
                </button>
              </span>
            </li>
          </ul>
        </div>

        <div v-if="localBranches.length > 0" class="bp-section">
          <button class="bp-section-toggle" :aria-expanded="showLocal ? 'true' : 'false'" @click.stop="showLocal = !showLocal">
            <svg class="bp-section-toggle__chevron" :class="{ 'bp-section-toggle__chevron--open': showLocal }" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{{ t('branches.local') }}</span>
            <span class="bp-section-toggle__count">{{ localBranches.length }}</span>
          </button>
          <ul v-if="showLocal" class="bp-list">
            <template v-for="branch in localBranches" :key="branch.name">
              <li
                class="bp-item"
                :class="{ 'bp-item--current': branch.isCurrent }"
                @click="!branch.isCurrent && handleBranchSwitch(branch.name)"
              >
                <span v-if="branch.isCurrent" class="bp-current-dot"></span>
                <svg v-if="props.worktreeBranches?.has(branch.name)" class="branch-wt-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px; color: var(--color-success); flex-shrink: 0;">
                  <circle cx="8" cy="4.5" r="2.5" />
                  <circle cx="4.5" cy="8.5" r="2.5" />
                  <circle cx="11.5" cy="8.5" r="2.5" />
                  <rect x="7.5" y="8" width="1" height="6" />
                </svg>
                <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
                <span v-if="branch.ahead > 0 || branch.behind > 0" class="bp-item-meta muted">
                  <span v-if="branch.ahead > 0">&uarr;{{ branch.ahead }}</span>
                  <span v-if="branch.behind > 0">&darr;{{ branch.behind }}</span>
                </span>
                <span v-if="!branch.isCurrent" class="bp-item-actions" @click.stop>
                  <button
                    class="bp-item-action"
                    :class="{ 'bp-item-action--active': pins.isPinned(branch.name) }"
                    :title="pins.isPinned(branch.name) ? t('branch.unpin') : t('branch.pin')"
                    @click.stop="togglePin(branch.name)"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" :fill="pins.isPinned(branch.name) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                      <path d="M8 1l2 4.5 5 .5-3.7 3.3L12.5 15 8 12.3 3.5 15l1.2-5.7L1 6l5-.5z" stroke-linejoin="round"/>
                    </svg>
                  </button>
                  <button
                    class="bp-item-action"
                    :class="{ 'bp-item-action--active': archives.isArchived(branch.name) }"
                    :title="archives.isArchived(branch.name) ? t('branch.unarchive') : t('branch.archive')"
                    @click.stop="toggleArchive(branch.name)"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                      <path d="M1.5 2.5h13v3h-13zM2.5 5.5h11v8h-11z" stroke-linejoin="round"/>
                      <path d="M6.5 8.5h3" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <button
                    class="bp-item-action"
                    :class="{ 'bp-item-action--active': previewingBranch === branch.name }"
                    :title="t('branches.previewMerge')"
                    @click.stop="togglePreview(branch.name)"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
                      <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    </svg>
                  </button>
                  <button
                    class="bp-item-action"
                    :title="t('worktree.openInWorktreeTabTooltip')"
                    @click.stop="emit('openWorktrees', branch.name); closePopover();"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" />
                      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" />
                      <rect x="5.5" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" />
                      <path d="M4.5 7v1.5M11.5 7v1.5M4.5 8.5h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    </svg>
                  </button>
                  <button
                    class="bp-item-action bp-item-action--danger"
                    :title="t('branches.deleteLabel')"
                    @click.stop="emit('deleteBranch', branch.name)"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </button>
                </span>
              </li>
              <li v-if="previewingBranch === branch.name" class="bp-preview-row">
                <!-- Commit picker — only visible when cherry-pick is selected -->
                <div v-if="previewOperation === 'cherry-pick'" class="bp-commit-picker">
                  <label class="bp-commit-picker__label">{{ t('mergePreview.commitPicker') }}</label>
                  <span v-if="cherryPickCommitsLoading" class="bp-commit-picker__loading muted">
                    {{ t('mergePreview.commitPickerLoading') }}
                  </span>
                  <span v-else-if="!cherryPickCommitsLoading && cherryPickCommits.length === 0" class="bp-commit-picker__loading muted">
                    {{ t('mergePreview.commitPickerEmpty') }}
                  </span>
                  <select
                    v-else
                    class="bp-commit-picker__select mono"
                    :value="selectedCherryPickSha ?? ''"
                    @change="onCherryPickCommitChange(($event.target as HTMLSelectElement).value)"
                  >
                    <option
                      v-for="commit in cherryPickCommits"
                      :key="commit.sha"
                      :value="commit.sha"
                    >[{{ commit.shortSha }}] {{ commit.message }}</option>
                  </select>
                </div>
                <MergePreviewPanel
                  :loading="previewLoading"
                  :error="previewError"
                  :summary="previewSummary"
                  :conflicting-files="previewConflicts"
                  :risk-level="previewRisk"
                  :operation="previewOperation"
                  :target-branch="branchDisplay"
                  :scratch-active="scratchActive"
                  :scratch-loading="scratchLoading"
                  :scratch-error="scratchError"
                  @update:operation="changePreviewOperation"
                  @resolve-in-scratch="handleResolveInScratch"
                  @scratch-merge-back="handleScratchMergeBack"
                  @scratch-discard="handleScratchDiscard"
                  @close="closePreview"
                />
              </li>
            </template>
          </ul>
        </div>
        <!-- Archived branches (relocated from the Dashboard, v3) — collapsible -->
        <div v-if="archivedBranchList.length > 0" class="bp-section">
          <button class="bp-section-toggle" :aria-expanded="showArchived ? 'true' : 'false'" @click.stop="showArchived = !showArchived">
            <svg class="bp-section-toggle__chevron" :class="{ 'bp-section-toggle__chevron--open': showArchived }" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{{ t('sidebar.archivedBranches') }}</span>
            <span class="bp-section-toggle__count">{{ archivedBranchList.length }}</span>
          </button>
          <ul v-if="showArchived" class="bp-list">
            <li
              v-for="branch in archivedBranchList"
              :key="`arch-${branch.name}`"
              class="bp-item bp-item--remote"
              :class="{ 'bp-item--current': branch.isCurrent }"
              @click="!branch.isCurrent && handleBranchSwitch(branch.name)"
            >
              <span v-if="branch.isCurrent" class="bp-current-dot"></span>
              <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
              <span class="bp-item-actions" @click.stop>
                <button class="bp-item-action" :title="t('branch.unarchive')" @click.stop="archives.unarchive(branch.name)">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <path d="M1.5 2.5h13v3h-13zM2.5 5.5h11v8h-11z" stroke-linejoin="round"/>
                    <path d="M8 12V7.5M6 9.5L8 7.5l2 2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </span>
            </li>
          </ul>
        </div>

        <div v-if="remoteBranches.length > 0" class="bp-section">
          <button class="bp-section-toggle" :aria-expanded="showRemote ? 'true' : 'false'" @click.stop="showRemote = !showRemote">
            <svg class="bp-section-toggle__chevron" :class="{ 'bp-section-toggle__chevron--open': showRemote }" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{{ t('branches.remote') }}</span>
            <span class="bp-section-toggle__count">{{ remoteBranches.length }}</span>
          </button>
          <ul v-if="showRemote" class="bp-list">
            <li
              v-for="branch in remoteBranches"
              :key="branch.name"
              class="bp-item bp-item--remote"
              @click="handleBranchSwitch(branch.name.replace(/^origin\//, ''))"
            >
              <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
            </li>
          </ul>
        </div>
        <div v-if="localBranches.length === 0 && remoteBranches.length === 0" class="bp-empty">
          <span class="muted">{{ t('branches.noBranch') }}</span>
        </div>

        <!-- Submodules section (v2.15.1) — only rendered when the repo declares submodules -->
        <div v-if="submodules.length > 0" class="bp-section bp-section--submodules">
          <button class="bp-section-toggle" :aria-expanded="showSubmodules ? 'true' : 'false'" @click.stop="showSubmodules = !showSubmodules">
            <svg class="bp-section-toggle__chevron" :class="{ 'bp-section-toggle__chevron--open': showSubmodules }" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{{ t('submodule.title') }}</span>
            <span class="bp-section-toggle__count">{{ submodules.length }}</span>
          </button>

          <ul v-if="showSubmodules" class="bp-list">
            <template v-for="sub in submodules" :key="sub.path">
              <li class="bp-item bp-item--submodule" @click="toggleSubmoduleExpand(sub.path)">
                <svg class="bp-sub-chevron" :class="{ 'bp-sub-chevron--open': expandedSubmodule === sub.path }" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span class="bp-item-name mono">{{ sub.path }}</span>
                <button
                  class="bp-item-preview"
                  :title="t('submodule.viewTree')"
                  @click.stop="openSubmoduleTree(sub.path)"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.5" />
                    <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.5" />
                    <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.5" />
                    <path d="M5 6v4M10 8H7c-1.1 0-2-.9-2-2" stroke="currentColor" stroke-width="1.5" />
                  </svg>
                </button>
              </li>
              <li v-if="expandedSubmodule === sub.path" class="bp-sub-branches">
                <span
                  v-for="b in (submoduleBranches[sub.path] ?? [])"
                  :key="b.name"
                  class="bp-sub-branch mono"
                  :class="{ 'bp-sub-branch--current': b.isCurrent }"
                >
                  <span v-if="b.isCurrent" class="bp-current-dot"></span>{{ b.name }}
                </span>
                <span v-if="(submoduleBranches[sub.path] ?? []).length === 0" class="muted bp-sub-empty">{{ t('submodule.noBranches') }}</span>
              </li>
            </template>
          </ul>
        </div>
      </div>
    </div>

    <!-- New-branch modal -->
    <BaseModal
      v-if="showCreate"
      :title="t('branches.create')"
      size="sm"
      @close="cancelCreate"
    >
      <BranchNameField
        v-model="newBranchName"
        :ai-available="ai.isAvailable.value"
        :suggesting="isGeneratingBranchName"
        :error="branchNameAiError ?? ''"
        @suggest="handleBranchNameAI"
        @submit="handleBranchCreate"
      />

      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="cancelCreate">{{ t('common.cancel') }}</button>
        <button class="bm-btn bm-btn--primary" :disabled="!newBranchName.trim()" @click="handleBranchCreate">
          {{ t('common.create') }}
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
/* ─── Branch trigger ────────────────────────────────────── */
.branch-popover-wrapper {
  position: relative;
}

/* Trigger + "new branch" button read as one fused control. */
.branch-trigger-group {
  display: inline-flex;
  align-items: stretch;
  max-width: 100%;
  min-width: 0;
}

.branch-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  padding: 0 2px 0 0;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-left: 1px solid var(--color-bg);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  cursor: pointer;
  transition: background var(--transition-base), color var(--transition-base);
}
.branch-add-btn:hover {
  background: var(--color-border);
  color: var(--color-text);
}

.branch-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  /* Softer, less "pill-y" radius — reads like a field/selector rather
     than a toggle chip. */
  border-radius: var(--radius-md);
  color: var(--color-text);
  background: var(--color-bg-tertiary);
  transition: background var(--transition-base), color var(--transition-base);
  cursor: pointer;
  max-width: 320px;
  min-width: 0;
}
.branch-trigger-group .branch-trigger {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.branch-trigger:hover {
  background: var(--color-border);
}
.branch-trigger--loading {
  opacity: 0.7;
  pointer-events: none;
}
/* Beefier vertical padding when a stats line is present so both rows
   breathe. Without this the 2-line layout looks cramped at the top/bottom. */
.branch-trigger--with-stats {
  padding-top: var(--space-2);
  padding-bottom: var(--space-2);
}

.branch-trigger__icon {
  flex-shrink: 0;
  /* Nudge the icon up so it sits on the same baseline as the branch
     name row (and not mid-height between the two lines). */
  align-self: flex-start;
  margin-top: 3px;
}
.branch-trigger:not(.branch-trigger--with-stats) .branch-trigger__icon {
  align-self: center;
  margin-top: 0;
}

/* Vertical stack holding the name on line 1 and stats on line 2. */
.branch-trigger__body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  line-height: 1.15;
}

.branch-trigger__name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.branch-trigger__name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 240px;
}

.branch-trigger__changes-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  border: 1.2px dashed var(--color-accent);
  flex-shrink: 0;
  transition: transform var(--transition-fast), border-color var(--transition-fast);
}
.branch-trigger__changes-dot:hover {
  transform: scale(1.2);
  border-color: var(--color-accent-hover, var(--color-accent));
}

/* Inline stats row: tiny dots + count label + unit. Colour-muted so
   the branch name remains the primary read. */
.branch-trigger__stats {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: var(--space-3);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

.branch-trigger__stat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.branch-trigger__stat-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}

.branch-chevron {
  transition: transform var(--transition-base);
  opacity: 0.5;
  flex-shrink: 0;
  align-self: center;
}
.branch-chevron--open { transform: rotate(180deg); }

.btn-spinner { animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Branch popover ────────────────────────────────────── */
.branch-popover {
  position: absolute;
  top: calc(100% + var(--space-3));
  left: 0;
  width: 420px;
  max-width: calc(100vw - var(--space-7));
  max-height: min(720px, 80vh);
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
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.bp-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.bp-filter {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-base);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.bp-filter:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
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
  /* Grows with the branch count, but the popover's own max-height keeps it
     bounded and scrollable when there are a lot of branches. */
  max-height: none;
}

.bp-section { border-bottom: 1px solid var(--color-border); }
.bp-section:last-child { border-bottom: none; }

.bp-list { list-style: none; }

.bp-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  cursor: pointer;
  transition: background var(--transition-fast);
  font-size: var(--font-size-base);
}
.bp-item:hover { background: var(--color-bg-tertiary); }
.bp-item--current { background: var(--color-bg-tertiary); cursor: default; }

.bp-current-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  flex-shrink: 0;
}

.bp-item-name {
  flex: 1;
  /* Stretch over the row's vertical padding so the hover/tooltip target
     is the full row height — no dead gap above/below the text. */
  align-self: stretch;
  display: flex;
  align-items: center;
  margin-block: calc(var(--space-3) * -1);
  padding-block: var(--space-3);
  min-width: 0;
  font-weight: var(--font-weight-medium);
}
.bp-item-name__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.bp-item--remote .bp-item-name { opacity: 0.7; }

.bp-item-meta {
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

/* Fused action group — reads as one segmented control, like the
   branch-trigger + "new branch" pair. Always visible (no hover reveal). */
.bp-item-actions {
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
  /* Nudge toward the row's right edge — claws back most of the item's
     right padding without affecting the branch-name column. */
  margin-right: calc(var(--space-5) * -0.6);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg);
}

.bp-item-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  border-left: 1px solid var(--color-border);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.bp-item-action:first-child { border-left: 0; }
.bp-item-action:hover { background: var(--color-bg-tertiary); color: var(--color-accent); }
.bp-item-action--active { color: var(--color-accent); background: var(--color-accent-soft); }
.bp-item-action--danger:hover { color: var(--color-danger); }

/* Submodule row "view tree" button — single icon, hover-reveal. */
.bp-item-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}
.bp-item:hover .bp-item-preview { opacity: 0.6; }
.bp-item-preview:hover { opacity: 1 !important; color: var(--color-accent); }

.bp-preview-row {
  list-style: none;
  padding: var(--space-2) var(--space-4) var(--space-3);
}

/* ─── Submodules section (v2.15.1) ──────────────────────── */
.bp-section-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  background: var(--color-bg);
  border: 0;
  cursor: pointer;
  text-align: left;
}
.bp-section-toggle:hover { color: var(--color-text); }

.bp-section-toggle__chevron {
  transition: transform var(--transition-base);
  opacity: 0.6;
}
.bp-section-toggle__chevron--open { transform: rotate(0deg); }
.bp-section-toggle__chevron:not(.bp-section-toggle__chevron--open) { transform: rotate(-90deg); }

.bp-section-toggle__count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.bp-item--submodule { cursor: pointer; }

.bp-sub-chevron {
  flex-shrink: 0;
  opacity: 0.5;
  transition: transform var(--transition-base);
}
.bp-sub-chevron--open { transform: rotate(90deg); }

.bp-sub-branches {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-5) var(--space-3) calc(var(--space-5) + 16px);
}

.bp-sub-branch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  padding: 1px 6px;
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
}
.bp-sub-branch--current { color: var(--color-text); font-weight: var(--font-weight-medium); }

.bp-sub-empty {
  font-size: var(--font-size-xs);
}

.bp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-7);
  font-size: var(--font-size-base);
}

/* ─── Cherry-pick commit picker ─────────────────────────── */
.bp-commit-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.bp-commit-picker__label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.bp-commit-picker__loading {
  font-size: var(--font-size-xs);
}

.bp-commit-picker__select {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-commit-picker__select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

</style>
