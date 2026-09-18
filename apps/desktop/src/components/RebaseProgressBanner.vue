<script setup lang="ts">
/**
 * RebaseProgressBanner — a NON-blocking top banner shown when a plain rebase
 * (e.g. from `git pull --rebase`) is paused due to conflicts.
 *
 * Distinct from the interactive RebaseEditor: this handles the simpler
 * case where the user just needs Continue / Skip / Abort.
 *
 * Rendered inline at the top of the changes view (mirrors `.conflict-banner`
 * in App.vue) rather than as a centred modal — so the diff / resolution area
 * underneath stays fully reachable while conflicts are being resolved.
 */
import { ref, computed } from "vue";
import type { OperationKind, RepoOperationState } from "../utils/backend";
import { t } from "../composables/useI18n";

const props = defineProps<{
  repoState: RepoOperationState;
  /** Driven by the parent while the whole-rebase auto-resolve loop runs. */
  autoResolving?: boolean;
  /**
   * v3.11 (#128 follow-up) — the halted commit was marked `split` in the
   * interactive rebase. The parent resolves this; the banner only renders it.
   */
  pendingSplit?: boolean;
  /**
   * Runs the action and resolves when it is done. Supplied by App.vue so the
   * confirmation, the error surface and the post-abort cleanup all live in one
   * place instead of being split across this component.
   */
  onAction: (action: "continue" | "abort" | "skip") => Promise<void>;
}>();

const emit = defineEmits<{
  (e: "auto-resolve"): void;
  /** v3.11 — open the split modal for the commit this rebase is halted on. */
  (e: "split"): void;
}>();

const busy = ref(false);

// Any in-flight action (Continue/Skip/Abort or the whole-rebase auto-resolve
// loop) disables the whole button row to avoid overlapping git operations.
const anyBusy = computed(() => busy.value || props.autoResolving === true);

const shortHead = computed(() =>
  props.repoState.operationHead
    ? props.repoState.operationHead.slice(0, 7)
    : ""
);

/**
 * Which operation this banner is driving. `rebase_interactive` collapses to
 * `rebase`: continue/abort/skip are the same git subcommand either way.
 */
const operation = computed<OperationKind>(() =>
  props.repoState.state === "rebase_interactive"
    ? "rebase"
    : (props.repoState.state as OperationKind),
);

/** A rebase owns the extras: step counter, split-at-edit-stop, auto-resolve. */
const isRebase = computed(() => operation.value === "rebase");

/** git has no `merge --skip`, so the button must not exist for a merge. */
const canSkip = computed(() => operation.value !== "merge");

/**
 * The banner's title names the operation. Without this it read "Rebase paused"
 * during a merge — caught in manual QA, and exactly the kind of thing that
 * makes a UI untrustworthy.
 */
const pausedTitle = computed(() => {
  switch (operation.value) {
    case "cherry_pick":
      return t("header.pausedCherryPick");
    case "revert":
      return t("header.pausedRevert");
    case "merge":
      return t("header.pausedMerge");
    default:
      return t("rebase.bannerTitle");
  }
});

/** The abort button names the operation it is abandoning. */
const abortLabel = computed(() => {
  switch (operation.value) {
    case "cherry_pick":
      return t("header.abortCherryPick");
    case "revert":
      return t("header.abortRevert");
    case "merge":
      return t("header.abortMerge");
    default:
      return t("rebase.abort");
  }
});

const stepLabel = computed(() => {
  if (props.repoState.step && props.repoState.total)
    return `${props.repoState.step} / ${props.repoState.total}`;
  return "";
});

/**
 * Ask the parent to run the action; do not run it here.
 *
 * The banner used to call the IPC wrapper itself, which left no room for the
 * confirmation an abort needs when it would discard resolution work — and put
 * business logic in a component, which this codebase keeps in composables.
 * App.vue owns the call now, through `runOperationAction`.
 */
async function runAction(action: "continue" | "abort" | "skip") {
  if (busy.value) return;
  busy.value = true;
  try {
    await props.onAction(action);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="rpm-banner" :class="{ 'rpm-banner--ready': !repoState.hasConflict }" role="status">
    <!-- Icon -->
    <div class="rpm-icon" :class="{ 'rpm-icon--conflict': repoState.hasConflict }">
      <svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="24" />
        <!-- rebase arrows -->
        <path d="M17 12v6a4 4 0 0 0 4 4h6m0 0-3-3m3 3-3 3" stroke-width="2.5" stroke-linecap="round"
          stroke-linejoin="round" />
        <path d="M31 36v-6a4 4 0 0 0-4-4h-6m0 0 3 3m-3-3 3-3" stroke-width="2.5" stroke-linecap="round"
          stroke-linejoin="round" />
      </svg>
    </div>

    <!-- Title + meta + hint, all inline -->
    <div class="rpm-text">
      <span class="rpm-title">{{ pausedTitle }}</span>
      <span class="rpm-meta" v-if="shortHead || stepLabel">
        <code v-if="shortHead">{{ shortHead }}</code>
        <span v-if="repoState.targetBranch">→ <strong>{{ repoState.targetBranch }}</strong></span>
        <span v-if="isRebase && stepLabel" class="rpm-step">{{ stepLabel }}</span>
      </span>
      <span class="rpm-hint" :class="repoState.hasConflict ? 'rpm-hint--conflict' : 'rpm-hint--ready'">
        {{ repoState.hasConflict ? t('rebase.bannerConflictHint') : t('rebase.bannerReadyHint') }}
      </span>
    </div>

    <!-- Actions -->
    <div class="rpm-actions">
      <button class="rpm-btn rpm-btn--danger" :disabled="anyBusy" @click="runAction('abort')">
        {{ abortLabel }}
      </button>
      <button v-if="canSkip" class="rpm-btn" :disabled="anyBusy" @click="runAction('skip')">
        {{ t('rebase.skip') }}
      </button>
      <!-- Auto-resolve: drives the WHOLE rebase (resolve → stage → continue,
           looped across every step) until it finishes or hits a conflict it
           can't resolve. Engine-first, with AI fallback when configured. -->
      <button v-if="isRebase && repoState.hasConflict" class="rpm-btn rpm-btn--auto"
        :disabled="anyBusy" :title="t('rebase.resolveAutoHint')" @click="emit('auto-resolve')">
        <span v-if="autoResolving" class="rpm-spinner" aria-hidden="true" />
        {{ autoResolving ? t('rebase.resolveAutoBusy') : t('rebase.resolveAuto') }}
      </button>
      <!-- v3.11 (#128 follow-up): closing RebaseEditor for the conflict banner
           took the "Split this commit…" affordance with it, leaving only
           Continue/Skip/Abort for the rest of the rebase.

           Gated on `!hasConflict`, which is a correctness condition rather
           than a cosmetic one. `gitSplitCommit` does `reset --mixed HEAD^`, so
           it needs HEAD to BE the commit being split. Verified against real
           git: at an `edit` stop HEAD is the freshly created commit, which is
           right; at a conflict stop the commit does not exist yet and HEAD is
           its parent, so splitting there would split the previous commit. -->
      <button v-if="isRebase && pendingSplit && !repoState.hasConflict"
        class="rpm-btn rpm-btn--primary rpm-btn--split"
        :disabled="anyBusy" @click="emit('split')">
        {{ t('rebase.splitThisCommit') }}
      </button>
      <!-- Demoted to neutral while Split is offered, so the two primaries do
           not compete (same treatment RebaseEditor gives them). -->
      <button class="rpm-btn" :class="{ 'rpm-btn--primary': !(pendingSplit && !repoState.hasConflict) }"
        :disabled="anyBusy || repoState.hasConflict"
        :title="repoState.hasConflict ? t('rebase.bannerConflictHint') : t('rebase.continue')"
        @click="runAction('continue')">
        <span v-if="busy" class="rpm-spinner" aria-hidden="true" />
        {{ t('header.operationContinue') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ── Banner ──────────────────────────────────────────────────────────── */
/* Mirrors `.conflict-banner` in App.vue: a non-blocking, top-of-view strip
   that keeps the resolution area below fully reachable. */
.rpm-banner {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  background: var(--color-warning-bg);
  border-left: 3px solid var(--color-warning);
  flex-shrink: 0;
}

.rpm-banner--ready {
  background: var(--color-success-soft, rgba(166, 227, 161, 0.12));
  border-left-color: var(--color-success, #a6e3a1);
}

/* ── Icon ────────────────────────────────────────────────────────────── */
.rpm-icon {
  flex-shrink: 0;
  line-height: 0;
}

.rpm-icon svg circle {
  fill: transparent;
}

.rpm-icon svg path {
  stroke: var(--color-success, #a6e3a1);
}

.rpm-icon--conflict svg path {
  stroke: var(--color-warning);
}

/* ── Text ────────────────────────────────────────────────────────────── */
.rpm-text {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.rpm-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.rpm-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.rpm-meta code {
  font-family: var(--gw-font-mono, monospace);
  background: var(--color-bg-tertiary, #313244);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-size-xs);
}

.rpm-step {
  background: var(--color-bg-tertiary, #313244);
  padding: 1px 6px;
  border-radius: 10px;
  font-size: var(--font-size-xs);
}

.rpm-hint {
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.rpm-hint--conflict {
  color: var(--color-warning);
}

.rpm-hint--ready {
  color: var(--color-success, #a6e3a1);
}

/* ── Actions ─────────────────────────────────────────────────────────── */
.rpm-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  margin-left: auto;
}

.rpm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: var(--space-2) var(--space-5);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
}

.rpm-btn:hover:not(:disabled) {
  background: var(--color-border);
}

.rpm-btn:disabled {
  cursor: not-allowed;
}

/* Abort: neutral button with red label, so it reads as destructive
   without disappearing into the banner like borderless text would. */
.rpm-btn--danger {
  color: var(--color-danger, #dc2626);
}

.rpm-btn--danger:hover:not(:disabled) {
  background: var(--color-danger, #dc2626);
  border-color: var(--color-danger, #dc2626);
  color: #fff;
}

/* Continue: primary call-to-action — uses the purple accent so it clearly
   reads as the main action (mirrors .bm-btn--primary in BaseModal). */
.rpm-btn--primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text, #fff);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08), 0 4px 10px rgba(124, 58, 237, 0.22);
}

.rpm-btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover, var(--color-accent));
  border-color: var(--color-accent-hover, var(--color-accent));
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.08), 0 8px 16px rgba(124, 58, 237, 0.28);
}

/* Disabled primary (conflicts unresolved): muted, no accent — matches BaseModal. */
.rpm-btn--primary:disabled {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border);
  color: var(--color-text-muted);
  box-shadow: none;
}

/* Auto-resolve: solid accent fill — the one-click "walk the whole rebase"
   shortcut, the boldest action in the row while conflicts remain. */
.rpm-btn--auto {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text, #fff);
}

.rpm-btn--auto:hover:not(:disabled) {
  background: var(--color-accent-hover, var(--color-accent));
  border-color: var(--color-accent-hover, var(--color-accent));
}

/* ── Spinner ─────────────────────────────────────────────────────────── */
.rpm-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: rpm-spin 0.6s linear infinite;
  flex-shrink: 0;
}

@keyframes rpm-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
