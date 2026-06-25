<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "../composables/useI18n";
import {
  useInteractiveRebase,
  getPendingSplitAtHead,
  resolvePendingSplit,
  type RebaseTodoEntry,
  type RebaseAction,
} from "../composables/useInteractiveRebase";
import { useSplitCommit } from "../composables/useSplitCommit";
import { getGitBranches, type GitBranch } from "../utils/backend";
import { branchSort } from "../utils/branchSort";
import { useAIProvider } from "../composables/useAIProvider";
import { useSquashSuggestion, type SquashSuggestion } from "../composables/useSquashSuggestion";
import BaseModal from "./BaseModal.vue";
import AiSparkle from "./AiSparkle.vue";

const props = defineProps<{
  cwd: string;
  currentBranch: string;
  branches: GitBranch[];
  initialBase?: string;
}>();

// ─── Local branches (fetched on mount for freshness) ─────────
const localBranches = ref<GitBranch[]>([]);
const branchesLoading = ref(false);
// Surfaced in the picker when the branch fetch fails — previously swallowed,
// which left the modal blank with no explanation.
const branchError = ref<string | null>(null);

async function fetchBranches() {
  branchesLoading.value = true;
  branchError.value = null;
  try {
    // Sort once here (order is invariant across filter keystrokes) using the
    // app-wide canonical branch ordering.
    localBranches.value = (await getGitBranches(props.cwd)).sort(branchSort);
  } catch (e: any) {
    branchError.value = e?.message ?? String(e);
  } finally {
    branchesLoading.value = false;
  }

  // Right-click entry ("rebase onto <branch>") passes an initial base. Select it
  // directly rather than matching it against the local list — the base may be a
  // remote-tracking ref, a tag, or a SHA, none of which need to appear in
  // `localBranches`. `listCommits` validates the ref.
  if (props.initialBase) {
    await selectBase(props.initialBase);
  }
}

const emit = defineEmits<{
  close: [];
  done: [];
  // Destructive hard-reset of the current branch onto `base`. App-level owns the
  // confirmation, execution, refresh and error reporting (same path as the
  // "reset to origin" shortcut) — the editor only signals intent.
  resetOnto: [base: string];
}>();

const { t, locale } = useI18n();
const rebase = useInteractiveRebase();
const ai = useAIProvider();
const {
  isGenerating: isSuggestingSquash,
  suggest: suggestSquashPlan,
  lastError: squashAiError,
} = useSquashSuggestion();
const squashSuggestion = ref<SquashSuggestion | null>(null);

async function handleSquashSuggest() {
  squashSuggestion.value = null;
  try {
    const plan = await suggestSquashPlan(props.cwd, rebase.todoEntries.value, {
      locale: locale.value,
    });
    squashSuggestion.value = plan;
  } catch {
    // surfaced via squashAiError
  }
}

function applySquashSuggestion() {
  const plan = squashSuggestion.value;
  if (!plan) return;
  for (const group of plan.groups) {
    // Leave the first commit of the group as 'pick'; squash the rest
    // into it. The user can still tweak actions manually afterwards.
    for (let i = 1; i < group.indices.length; i++) {
      rebase.setAction(group.indices[i], "squash");
    }
  }
  squashSuggestion.value = null;
}

function dismissSquashSuggestion() {
  squashSuggestion.value = null;
}

// ─── Base selection ──────────────────────────────────────────
const baseInput = ref("");
const baseFilter = ref("");
const showBasePicker = ref(true);

const baseCandidates = computed(() => {
  const filter = baseFilter.value.toLowerCase();
  return localBranches.value
    // Exclude only the current branch (rebasing onto yourself replays nothing).
    // Remote-tracking branches are valid, common bases — keep them, tagged in
    // the UI — so a repo whose only local branch is the current one still has
    // something to pick.
    .filter(
      (b) =>
        !b.isCurrent &&
        b.name.toLowerCase().includes(filter),
    )
    // localBranches is already sorted (branchSort) at fetch time; filtering
    // preserves order.
    .map((b) => ({ name: b.name, isRemote: b.isRemote }));
});

// Let the user type any ref (tag, SHA, or a branch not in the list) as the base.
// Offered when the filter text matches no candidate by exact name.
const typedRef = computed(() => baseFilter.value.trim());
const showUseTyped = computed(
  () =>
    typedRef.value.length > 0 &&
    !baseCandidates.value.some((c) => c.name === typedRef.value),
);

function onBaseInputEnter() {
  if (showUseTyped.value) selectBase(typedRef.value);
  else if (baseCandidates.value.length === 1) selectBase(baseCandidates.value[0].name);
}

async function selectBase(name: string) {
  baseInput.value = name;
  const entries = await rebase.listCommits(props.cwd, name);
  // Hide the picker only when there's a todo to edit. With nothing to replay we
  // keep the picker open so the user can pick a different base, and surface a
  // reset-to-base shortcut below it.
  showBasePicker.value = entries.length === 0;
}

// A base was chosen but the rebase has no commits to replay (base is equal to
// or ahead of HEAD). Distinct from loading/error/in-progress so the modal can
// show a recoverable empty-state — the picker stays open, plus a reset shortcut.
const noCommitsForBase = computed(
  () =>
    !!baseInput.value &&
    !inProgress.value &&
    !rebase.isLoading.value &&
    !rebase.error.value &&
    rebase.todoEntries.value.length === 0,
);


// ─── Drag & drop ─────────────────────────────────────────────
const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(index: number, e: DragEvent) {
  dragIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  }
}

function onDragOver(index: number, e: DragEvent) {
  e.preventDefault();
  dragOverIndex.value = index;
}

function onDragLeave() {
  dragOverIndex.value = null;
}

function onDrop(toIndex: number, e: DragEvent) {
  e.preventDefault();
  if (dragIndex.value !== null && dragIndex.value !== toIndex) {
    rebase.moveEntry(dragIndex.value, toIndex);
  }
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

// ─── Actions ─────────────────────────────────────────────────
const actions: RebaseAction[] = ["pick", "reword", "squash", "fixup", "edit", "split", "drop"];

const actionDescriptions: Record<RebaseAction, { fr: string; en: string }> = {
  pick:    { fr: "Garder tel quel",               en: "Keep as is" },
  reword:  { fr: "Modifier le message",           en: "Edit message" },
  squash:  { fr: "Fusionner (garder les messages)", en: "Merge (keep messages)" },
  fixup:   { fr: "Fusionner (ignorer le message)", en: "Merge (discard message)" },
  edit:    { fr: "S\u2019arr\u00eater pour modifier", en: "Pause to edit" },
  split:   { fr: "Scinder en deux commits",       en: "Split into two commits" },
  drop:    { fr: "Supprimer le commit",            en: "Remove commit" },
};

/** Index of the todo item whose action dropdown is open, or null. */
const actionMenuIndex = ref<number | null>(null);
const actionMenuStyle = ref<Record<string, string>>({});

function toggleActionMenu(index: number, e: MouseEvent) {
  if (actionMenuIndex.value === index) {
    actionMenuIndex.value = null;
    return;
  }
  actionMenuIndex.value = index;

  // Position the menu near the badge, using fixed positioning
  const btn = e.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const menuHeight = 220; // approximate

  if (spaceBelow < menuHeight) {
    // Open above
    actionMenuStyle.value = {
      position: "fixed",
      left: `${rect.left}px`,
      bottom: `${window.innerHeight - rect.top + 4}px`,
      top: "auto",
    };
  } else {
    // Open below
    actionMenuStyle.value = {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.bottom + 4}px`,
      bottom: "auto",
    };
  }
}

function pickAction(index: number, action: RebaseAction) {
  rebase.setAction(index, action);
  actionMenuIndex.value = null;
  if (action === "reword") startReword(index);
}

// ─── Reword inline edit ──────────────────────────────────────
const editingIndex = ref<number | null>(null);
const editMessage = ref("");

function startReword(index: number) {
  window.getSelection()?.removeAllRanges();
  rebase.setAction(index, "reword");
  editingIndex.value = index;
  editMessage.value = rebase.todoEntries.value[index].newMessage || rebase.todoEntries.value[index].message;
}

function confirmReword() {
  if (editingIndex.value !== null) {
    rebase.setNewMessage(editingIndex.value, editMessage.value);
    editingIndex.value = null;
  }
}

function cancelReword() {
  editingIndex.value = null;
}

// ─── Start / In-progress actions ─────────────────────────────

async function startRebase() {
  const result = await rebase.startRebase(
    props.cwd,
    baseInput.value,
    rebase.todoEntries.value,
  );
  // Only close when the rebase is fully finished. A halt on `edit` or our
  // synthetic `split` returns `success: true, conflict: false` because it's
  // not a merge conflict — but the rebase is mid-flight. `inProgress` is the
  // authoritative "is the rebase still running" signal.
  if (result.success && !result.inProgress) {
    emit("done");
  }
  // Otherwise, the progress banner stays visible and the UI adapts
  // (conflict UI, or "Split this commit…" button for pending-split halts).
}

async function doContinue() {
  const result = await rebase.rebaseContinue(props.cwd);
  if (result.success && !result.inProgress) {
    emit("done");
  }
}

async function doAbort() {
  await rebase.rebaseAbort(props.cwd);
  emit("close");
}

async function doSkip() {
  const result = await rebase.rebaseSkip(props.cwd);
  if (result.success && !result.inProgress) {
    emit("done");
  }
}

// ─── Split-at-halt integration ────────────────────────────────
//
// When the user marked a commit as `split` in the todo, the rebase halts on
// that commit as a regular `edit` stop. The composable's `pendingSplits` map
// remembers the intent — here we surface a prominent action that opens the
// `SplitCommitModal`. After a successful split, we auto-resume the rebase via
// `rebase.rebaseContinue()`, which is the natural next step (the user did ask
// for the commit to be split, not just paused on).
const splitCommit = useSplitCommit();

/** The commit currently halted on, IF it was originally marked for split. */
const pendingSplitAtHead = computed(() =>
  getPendingSplitAtHead(rebase.progress.value),
);

async function handleSplitAtHead() {
  const pending = pendingSplitAtHead.value;
  if (!pending) return;
  await splitCommit.openFor(
    props.cwd,
    { hash: pending.fullHash, message: pending.message },
    // Post-split hook: clear the pending entry, then continue the rebase.
    async () => {
      resolvePendingSplit(pending.fullHash);
      const result = await rebase.rebaseContinue(props.cwd);
      // Close the editor only when the rebase is fully finished. If another
      // halt follows (another edit/split, or a conflict), `inProgress` stays
      // true and the progress banner remains visible with the right affordances.
      if (result.success && !result.inProgress) {
        emit("done");
      }
    },
  );
}

// ─── Init on open ────────────────────────────────────────────
onMounted(async () => {
  await Promise.all([
    fetchBranches(),
    rebase.detectRebaseState(props.cwd),
  ]);
});

// Action badge colors
function actionClass(action: RebaseAction): string {
  const map: Record<RebaseAction, string> = {
    pick: "rb-action--pick",
    reword: "rb-action--reword",
    squash: "rb-action--squash",
    fixup: "rb-action--fixup",
    edit: "rb-action--edit",
    split: "rb-action--split",
    drop: "rb-action--drop",
  };
  return map[action];
}

// Close action menu on outside click
function onBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".rb-action-dropdown")) {
    actionMenuIndex.value = null;
  }
}

// Keyboard shortcut: Escape handling (BaseModal already closes on Escape
// when nothing else is active; we only intercept to cancel menu/reword first).
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (actionMenuIndex.value !== null) {
      e.stopPropagation();
      actionMenuIndex.value = null;
    } else if (editingIndex.value !== null) {
      e.stopPropagation();
      cancelReword();
    }
    // Otherwise let BaseModal handle the close.
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown, true));
onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));

// Derived flags for slot gating.
const inProgress = computed(() => !!rebase.progress.value?.inProgress);
const hasTodo = computed(
  () => rebase.todoEntries.value.length > 0 && !inProgress.value,
);
</script>

<template>
  <BaseModal
    size="lg"
    :title="t('rebase.title')"
    role="dialog"
    body-flush
    scroll-own
    @close="emit('close')"
  >
    <template #title-icon>
      <span class="rb-title-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <circle cx="6" cy="19" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <circle cx="18" cy="12" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <path d="M6 7.2v9.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <path d="M8.2 5H13a3 3 0 0 1 3 3v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <path d="M8.2 19H13a3 3 0 0 0 3-3v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </span>
    </template>

    <!-- ─── Toolbar: in-progress banner ───────────────────── -->
    <template v-if="inProgress" #toolbar>
      <div class="rb-progress-banner">
        <div class="rb-progress-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 1v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </div>
        <div class="rb-progress-text">
          <strong>{{ t('rebase.inProgress') }}</strong>
          <span v-if="rebase.progress.value?.headName"> — {{ rebase.progress.value.headName }}</span>
          <span v-if="rebase.progress.value?.step"> ({{ rebase.progress.value.step }}/{{ rebase.progress.value.total }})</span>
        </div>
        <div v-if="rebase.progress.value?.hasConflict" class="rb-conflict-badge">
          {{ t('rebase.conflict') }}
        </div>
      </div>
    </template>

    <!-- ─── Body ──────────────────────────────────────────── -->
    <div class="rb-body" @click="onBodyClick">
    <div class="rb-scroll">
      <!-- In-progress actions -->
      <div v-if="inProgress" class="rb-progress-actions">
        <button
          v-if="pendingSplitAtHead"
          class="bm-btn bm-btn--primary"
          @click="handleSplitAtHead"
          :disabled="rebase.isRunning.value || splitCommit.busy.value"
        >
          ✂️ {{ t('rebase.splitThisCommit') }}
        </button>
        <button
          class="bm-btn"
          :class="pendingSplitAtHead ? 'bm-btn--ghost' : 'bm-btn--primary'"
          @click="doContinue"
          :disabled="rebase.isRunning.value"
        >
          {{ t('rebase.continue') }}
        </button>
        <button class="bm-btn bm-btn--ghost" @click="doSkip" :disabled="rebase.isRunning.value">
          {{ t('rebase.skip') }}
        </button>
        <button class="bm-btn bm-btn--danger" @click="doAbort" :disabled="rebase.isRunning.value">
          {{ t('rebase.abort') }}
        </button>
      </div>

      <!-- Base selection -->
      <template v-if="showBasePicker && !inProgress">
        <div class="rb-section rb-section--picker">
          <label class="rb-label rb-label--base" for="rb-base-input">{{ t('rebase.baseLabel') }}</label>
          <p class="rb-hint">{{ t('rebase.baseHint') }}</p>
          <input
            id="rb-base-input"
            class="rb-base-input mono"
            v-model="baseFilter"
            :placeholder="t('rebase.basePlaceholder')"
            autofocus
            @keydown.enter.prevent="onBaseInputEnter"
          />
          <p v-if="branchError" class="rb-hint rb-hint--error">{{ branchError }}</p>
          <ul class="rb-base-list" v-if="baseCandidates.length > 0 || showUseTyped">
            <!-- Free-text ref: pick any tag, SHA, or branch the user typed. -->
            <li
              v-if="showUseTyped"
              class="rb-base-item rb-base-item--typed"
              @click="selectBase(typedRef)"
            >
              <svg class="rb-base-icon" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 1a.75.75 0 0 1 .75.75v5.5h5.5a.75.75 0 0 1 0 1.5h-5.5v5.5a.75.75 0 0 1-1.5 0v-5.5h-5.5a.75.75 0 0 1 0-1.5h5.5v-5.5A.75.75 0 0 1 8 1Z"/>
              </svg>
              <span class="mono">{{ t('rebase.useRef', typedRef) }}</span>
            </li>
            <li
              v-for="cand in baseCandidates"
              :key="cand.name"
              class="rb-base-item"
              @click="selectBase(cand.name)"
            >
              <svg class="rb-base-icon" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
              </svg>
              <span class="mono">{{ cand.name }}</span>
              <span v-if="cand.isRemote" class="rb-base-tag">{{ t('rebase.remoteTag') }}</span>
            </li>
          </ul>
        </div>
      </template>

      <!-- Commit list (todo editor) -->
      <template v-if="hasTodo">
        <div class="rb-section">
          <div class="rb-section-header">
            <div class="rb-label">
              {{ t('rebase.commitsLabel') }}
              <span class="rb-count">({{ rebase.todoEntries.value.length }})</span>
            </div>
            <div class="rb-section-actions">
              <button
                v-if="ai.isAvailable.value && rebase.todoEntries.value.length >= 2"
                class="btn btn--ai"
                :disabled="isSuggestingSquash"
                :title="t('rebase.aiSquashHint')"
                @click="handleSquashSuggest"
              >
                <span v-if="isSuggestingSquash" class="rb-ai-label">
                  <span class="rb-ai-spinner" aria-hidden="true"></span>
                  {{ t('rebase.aiSquashApplying') }}
                </span>
                <span v-else class="rb-ai-label">
                  <AiSparkle :size="14" />
                  {{ t('rebase.aiSquashSuggest') }}
                </span>
              </button>
              <button class="rb-back-btn" @click="showBasePicker = true; rebase.reset()">
                {{ t('rebase.changeBase') }}
              </button>
            </div>
          </div>
          <p class="rb-hint">{{ t('rebase.commitsHint') }}</p>
          <p v-if="squashAiError" class="rb-hint rb-hint--error">{{ squashAiError }}</p>

          <!-- Squash suggestion panel -->
          <div v-if="squashSuggestion" class="rb-squash-suggestion">
            <div class="rb-squash-header">
              <span class="rb-squash-title">
                <AiSparkle :size="14" />
                {{ squashSuggestion.summary || t('rebase.aiSquashSuggest') }}
              </span>
              <button class="rb-squash-dismiss" @click="dismissSquashSuggestion" :aria-label="t('rebase.aiSquashClose')">✕</button>
            </div>
            <p v-if="squashSuggestion.groups.length === 0" class="rb-squash-empty">
              {{ t('rebase.aiSquashEmpty') }}
            </p>
            <ul v-else class="rb-squash-groups">
              <li v-for="(group, gi) in squashSuggestion.groups" :key="gi" class="rb-squash-group">
                <div class="rb-squash-group-head">
                  <span class="rb-squash-group-indices mono">
                    {{ group.indices.map(i => `#${i + 1}`).join(', ') }}
                  </span>
                  <span v-if="group.combinedSubject" class="rb-squash-group-subject">
                    → {{ group.combinedSubject }}
                  </span>
                </div>
                <p v-if="group.reason" class="rb-squash-group-reason">{{ group.reason }}</p>
              </li>
            </ul>
            <div v-if="squashSuggestion.groups.length > 0" class="rb-squash-actions">
              <button class="rb-squash-apply" @click="applySquashSuggestion">
                {{ t('rebase.aiSquashApply') }}
              </button>
              <button class="rb-squash-cancel" @click="dismissSquashSuggestion">
                {{ t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>

        <div class="rb-todo-list">
          <div
            v-for="(entry, index) in rebase.todoEntries.value"
            :key="entry.fullHash"
            class="rb-todo-item"
            :class="{
              'rb-todo-item--dragging': dragIndex === index,
              'rb-todo-item--drag-over': dragOverIndex === index,
              'rb-todo-item--drop': entry.action === 'drop',
            }"
            draggable="true"
            @dragstart="onDragStart(index, $event)"
            @dragover="onDragOver(index, $event)"
            @dragleave="onDragLeave"
            @drop="onDrop(index, $event)"
            @dragend="onDragEnd"
          >
            <!-- Drag handle -->
            <div class="rb-drag-handle" :title="t('rebase.dragHint')">
              <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" opacity="0.4">
                <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
                <circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/>
                <circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/>
              </svg>
            </div>

            <!-- Action badge (click to open dropdown) -->
            <div class="rb-action-dropdown">
              <button
                class="rb-action-badge"
                :class="actionClass(entry.action)"
                @click.stop="toggleActionMenu(index, $event)"
              >
                {{ entry.action }}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <ul v-if="actionMenuIndex === index" class="rb-action-menu" :style="actionMenuStyle">
                <li
                  v-for="a in actions"
                  :key="a"
                  class="rb-action-menu-item"
                  :class="[actionClass(a), { 'rb-action-menu-item--active': entry.action === a }]"
                  @click.stop="pickAction(index, a)"
                >
                  <span class="rb-action-menu-dot" :class="actionClass(a)"></span>
                  <span class="rb-action-menu-name">{{ a }}</span>
                  <span class="rb-action-menu-desc">{{ locale.startsWith('fr') ? actionDescriptions[a].fr : actionDescriptions[a].en }}</span>
                </li>
              </ul>
            </div>

            <!-- Commit info -->
            <span class="rb-hash mono">{{ entry.hash }}</span>

            <!-- Message (inline edit when reword) -->
            <template v-if="editingIndex === index">
              <input
                class="rb-reword-input mono"
                v-model="editMessage"
                @keydown.enter="confirmReword"
                @keydown.escape="cancelReword"
                autofocus
              />
              <button class="rb-reword-ok" @click="confirmReword" :title="t('common.confirm')">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </template>
            <template v-else>
              <span
                class="rb-message"
                :class="{ 'rb-message--reword': entry.action === 'reword' && entry.newMessage }"
                @dblclick="startReword(index)"
              >
                {{ entry.action === 'reword' && entry.newMessage ? entry.newMessage : entry.message }}
              </span>
            </template>

            <span class="rb-meta muted">{{ entry.author }} · {{ entry.date }}</span>

            <!-- Quick action buttons -->
            <div class="rb-item-actions">
              <button
                v-if="entry.action !== 'reword'"
                class="rb-item-btn"
                @click="startReword(index)"
                :title="t('rebase.reword')"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2l2.5 2.5-6 6H1.5V8l6-6z" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button
                class="rb-item-btn rb-item-btn--drop"
                @click="rebase.setAction(index, entry.action === 'drop' ? 'pick' : 'drop')"
                :title="entry.action === 'drop' ? t('rebase.restore') : t('rebase.drop')"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
        </div>

      </template>

      <!-- Loading -->
      <div v-if="rebase.isLoading.value" class="rb-loading">
        <div class="rb-spinner"></div>
        {{ t('common.loading') }}
      </div>

      <!-- Error (only when no todo loaded) -->
      <div v-if="rebase.error.value && !rebase.todoEntries.value.length && !inProgress" class="rb-error-box">
        {{ rebase.error.value }}
      </div>
    </div>
    <!-- Empty-state pinned at the bottom of the modal body (outside the scroll
         region) so its reset/cancel actions stay visible on short screens. The
         picker above keeps scrolling so the user can still pick another base. -->
    <div v-if="noCommitsForBase" class="rb-empty">
      <p class="rb-empty-title">{{ t('rebase.noCommits') }}</p>
      <p class="rb-hint">{{ t('rebase.noCommitsHint', baseInput) }}</p>
      <button class="bm-btn bm-btn--danger" @click="emit('resetOnto', baseInput)">
        {{ t('rebase.resetOntoBase', baseInput) }}
      </button>
    </div>
    <!-- Legend pinned at the bottom of the modal body, above the footer -->
    <div v-if="hasTodo" class="rb-legend">
      <div v-for="a in actions" :key="a" class="rb-legend-item">
        <span class="rb-legend-dot" :class="actionClass(a)"></span>
        <span class="rb-legend-name">{{ a }}</span>
        <span class="rb-legend-desc">{{ locale.startsWith('fr') ? actionDescriptions[a].fr : actionDescriptions[a].en }}</span>
      </div>
    </div>
    </div>

    <!-- ─── Footer: todo-list actions ─────────────────────── -->
    <template v-if="hasTodo" #footer>
      <span v-if="rebase.error.value" class="rb-error">{{ rebase.error.value }}</span>
      <button class="bm-btn bm-btn--ghost" @click="emit('close')">
        {{ t('common.cancel') }}
      </button>
      <button
        class="bm-btn bm-btn--primary"
        @click="startRebase"
        :disabled="rebase.isRunning.value"
      >
        <template v-if="rebase.isRunning.value">{{ t('rebase.running') }}</template>
        <template v-else>{{ t('rebase.start') }}</template>
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
/* ─── Title icon chip ───────────────────────────────────── */
.rb-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft, rgba(124, 58, 237, 0.14));
  color: var(--color-accent);
  flex-shrink: 0;
}

/* ─── Body wrapper ──────────────────────────────────────── */
/* BaseModal uses scroll-own → the body is a flex column and .rb-body
   is a flex item that claims the remaining vertical space. This lets
   .rb-scroll scroll internally while .rb-legend stays pinned at the
   bottom (above the modal footer). */
.rb-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* BaseModal is body-flush here; inner sections own horizontal padding. */
}

.rb-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) 0;
  /* Flex column so the picker section can fill the free vertical space and let
     its branch list scroll internally (see .rb-section--picker). Other sections
     keep their natural height and overflow the scroll container as before. */
  display: flex;
  flex-direction: column;
}

/* ─── Sections ─────────────────────────────────────────────── */
.rb-section {
  padding: var(--space-4) var(--space-7);
}

/* Base picker fills the available height so its branch list adapts to the free
   space (shrinking when the pinned empty-state below claims room on short
   screens) and scrolls internally instead of growing the modal. */
.rb-section--picker {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rb-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rb-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted);
}

.rb-count {
  font-weight: 400;
  opacity: 0.7;
}

.rb-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin: 4px 0 var(--space-2);
}

.rb-back-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
}
.rb-back-btn:hover {
  background: var(--color-bg-secondary);
}

.rb-section-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* AI CTA content — sparkle + label line up cleanly inside .btn--ai. */
.rb-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.rb-ai-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: rb-spin 0.7s linear infinite;
}
@keyframes rb-spin {
  to { transform: rotate(360deg); }
}

.rb-hint--error {
  color: var(--color-danger, #ef4444);
}

/* ─── Squash suggestion panel ──────────────────────────── */
.rb-squash-suggestion {
  margin: var(--space-2) 0 4px;
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-md);
}

.rb-squash-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 6px;
}

.rb-squash-title {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-ai);
}

.rb-squash-dismiss {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.rb-squash-dismiss:hover { color: var(--color-text); }

.rb-squash-empty {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-style: italic;
}

.rb-squash-groups {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rb-squash-group {
  padding: 6px var(--space-2);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.rb-squash-group-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.rb-squash-group-indices {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-accent);
}

.rb-squash-group-subject {
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

.rb-squash-group-reason {
  margin: 4px 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.4;
}

.rb-squash-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: var(--space-2);
}

.rb-squash-apply,
.rb-squash-cancel {
  padding: 4px var(--space-4);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  border: 1px solid var(--color-border);
}

.rb-squash-apply {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}

.rb-squash-apply:hover { filter: brightness(1.08); }

.rb-squash-cancel {
  background: transparent;
  color: var(--color-text);
}

.rb-squash-cancel:hover { background: var(--color-bg-secondary); }

/* ─── Base picker ──────────────────────────────────────────── */
.rb-label--base {
  font-size: var(--font-size-md);
}

.rb-base-input {
  width: 100%;
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-md);
  line-height: 1.5;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.rb-base-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft, rgba(124, 58, 237, 0.18));
}

.rb-base-list {
  list-style: none;
  padding: 0;
  margin: var(--space-3) 0 0;
  /* Fill the free space left by the input/hint above (and the pinned
     empty-state below), scrolling internally so the modal keeps its size. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Breathing room so branch rows don't butt against the scrollbar. */
  padding-right: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.rb-base-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast), transform var(--transition-fast);
}
.rb-base-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
  transition: color var(--transition-fast);
}
.rb-base-item:hover {
  background: var(--color-accent-soft, rgba(124, 58, 237, 0.14));
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.rb-base-item:hover .rb-base-icon {
  color: var(--color-accent);
}
.rb-base-item:active {
  transform: translateY(1px);
}
/* Remote-tracking marker — muted pill so it reads as metadata, not an action. */
.rb-base-tag {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: var(--color-bg-subtle, rgba(127, 127, 127, 0.12));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
}
.rb-base-item:hover .rb-base-tag {
  color: var(--color-accent);
  border-color: var(--color-accent);
}
/* Free-text ref row: dashed outline so it reads as "type your own" rather than
   a concrete branch you can click. */
.rb-base-item--typed {
  border-style: dashed;
}

/* ─── Empty-state (no commits to rebase) ───────────────────── */
/* Pinned at the bottom of the modal body (sibling of .rb-legend, outside
   .rb-scroll) so the reset/cancel actions stay visible on short screens. */
.rb-empty {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-7) var(--space-7);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
}
.rb-empty-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text);
}

/* ─── Todo list ────────────────────────────────────────────── */
.rb-todo-list {
  padding: 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rb-todo-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  transition: background 0.1s, opacity 0.15s;
  cursor: default;
}
.rb-todo-item:hover {
  background: var(--color-bg-secondary);
}
.rb-todo-item--dragging {
  opacity: 0.4;
}
.rb-todo-item--drag-over {
  border-top: 2px solid var(--color-accent);
}
.rb-todo-item--drop {
  opacity: 0.45;
  text-decoration: line-through;
}

/* ─── Drag handle ──────────────────────────────────────────── */
.rb-drag-handle {
  cursor: grab;
  padding: 2px 4px;
  flex-shrink: 0;
}
.rb-drag-handle:active {
  cursor: grabbing;
}

/* ─── Action badge ─────────────────────────────────────────── */
.rb-action-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 2px 6px;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  min-width: 48px;
  text-align: center;
  flex-shrink: 0;
  transition: all 0.1s;
}

.rb-action--pick {
  background: var(--color-success-bg, rgba(46, 160, 67, 0.15));
  color: var(--color-success, #2ea043);
}
.rb-action--reword {
  background: rgba(130, 80, 223, 0.15);
  color: #8250df;
}
.rb-action--squash {
  background: rgba(218, 130, 25, 0.15);
  color: #da821a;
}
.rb-action--fixup {
  background: rgba(130, 130, 130, 0.15);
  color: var(--color-text-muted);
}
.rb-action--edit {
  background: rgba(56, 132, 255, 0.15);
  color: #3884ff;
}
.rb-action--split {
  background: rgba(139, 92, 246, 0.15);
  color: var(--color-accent, #8b5cf6);
}
.rb-action--drop {
  background: rgba(218, 54, 51, 0.15);
  color: var(--color-danger, #da3633);
}

/* ─── Action dropdown ──────────────────────────────────────── */
.rb-action-dropdown {
  position: relative;
  flex-shrink: 0;
}

.rb-action-badge svg {
  margin-left: 2px;
  opacity: 0.6;
}

.rb-action-menu {
  /* position is set inline (fixed) */
  min-width: 220px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  list-style: none;
  padding: 4px 0;
  z-index: 300;
}

.rb-action-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-4);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background 0.1s;
  background: none !important;
  color: var(--color-text) !important;
}
.rb-action-menu-item:hover {
  background: var(--color-bg-secondary) !important;
}
.rb-action-menu-item--active {
  font-weight: var(--font-weight-semibold);
}

.rb-action-menu-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rb-action-menu-dot.rb-action--pick { background: var(--color-success, #2ea043); }
.rb-action-menu-dot.rb-action--reword { background: #8250df; }
.rb-action-menu-dot.rb-action--squash { background: #da821a; }
.rb-action-menu-dot.rb-action--fixup { background: #828282; }
.rb-action-menu-dot.rb-action--edit { background: #3884ff; }
.rb-action-menu-dot.rb-action--split { background: var(--color-accent, #8b5cf6); }
.rb-action-menu-dot.rb-action--drop { background: var(--color-danger, #da3633); }

.rb-action-menu-name {
  font-weight: var(--font-weight-semibold);
  min-width: 48px;
}

.rb-action-menu-desc {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

/* ─── Commit info ──────────────────────────────────────────── */
.rb-hash {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  flex-shrink: 0;
}

.rb-message {
  font-size: var(--font-size-sm);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
}
.rb-message--reword {
  color: #8250df;
  font-style: italic;
}

.rb-meta {
  font-size: var(--font-size-xs);
  flex-shrink: 0;
  white-space: nowrap;
}

/* ─── Reword inline edit ───────────────────────────────────── */
.rb-reword-input {
  flex: 1;
  font-size: var(--font-size-sm);
  padding: 2px 6px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  outline: none;
}

.rb-reword-ok {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-success);
  padding: 2px;
}

/* ─── Item quick actions ───────────────────────────────────── */
.rb-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s;
  flex-shrink: 0;
}
.rb-todo-item:hover .rb-item-actions {
  opacity: 1;
}

.rb-item-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 3px;
  border-radius: var(--radius-sm);
}
.rb-item-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
.rb-item-btn--drop:hover {
  color: var(--color-danger);
}

/* ─── Legend ────────────────────────────────────────────────── */
.rb-legend {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px var(--space-5);
  padding: var(--space-3) var(--space-7);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
}

.rb-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}

.rb-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rb-legend-dot.rb-action--pick { background: var(--color-success, #2ea043); }
.rb-legend-dot.rb-action--reword { background: #8250df; }
.rb-legend-dot.rb-action--squash { background: #da821a; }
.rb-legend-dot.rb-action--fixup { background: #828282; }
.rb-legend-dot.rb-action--edit { background: #3884ff; }
.rb-legend-dot.rb-action--split { background: var(--color-accent, #8b5cf6); }
.rb-legend-dot.rb-action--drop { background: var(--color-danger, #da3633); }

.rb-legend-name {
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.rb-legend-desc {
  color: var(--color-text-muted);
}

/* ─── Progress banner (rendered inside BaseModal toolbar) ─── */
.rb-progress-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}

.rb-progress-icon {
  color: #da821a;
  display: inline-flex;
}

.rb-progress-text {
  font-size: var(--font-size-sm);
  flex: 1;
}

.rb-conflict-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px var(--space-2);
  border-radius: 3px;
  background: rgba(218, 54, 51, 0.15);
  color: var(--color-danger);
}

.rb-progress-actions {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-7);
  border-bottom: 1px solid var(--color-border);
}

/* ─── Loading / Error ──────────────────────────────────────── */
.rb-loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-7);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.rb-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: rb-spin 0.6s linear infinite;
}

@keyframes rb-spin {
  to { transform: rotate(360deg); }
}

.rb-error {
  font-size: var(--font-size-sm);
  color: var(--color-danger);
  margin-right: auto;
}

.rb-error-box {
  padding: var(--space-4) var(--space-7);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}
</style>
