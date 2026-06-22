<script setup lang="ts">
/**
 * BranchRowActions — the fused action segment shown at the right edge of a
 * branch row in the branch picker (pin/unpin, archive, preview-merge, open in
 * worktree, delete).
 *
 * Presentational only: it owns no state, just renders buttons from boolean
 * props and emits semantic intents. Used by both the Pinned and Local lists in
 * BranchSelector so the two stay identical.
 *
 * The current (checked-out) branch only exposes pin/unpin. Everything else is
 * invalid or a no-op on HEAD: git refuses to delete or open a second worktree
 * of the checked-out branch, and archiving / previewing a merge of a branch
 * into itself is meaningless. So `is-current` hides all but the pin button.
 */
import { useI18n } from "../../composables/useI18n";

defineProps<{
  pinned: boolean;
  archived: boolean;
  previewing: boolean;
  /** The checked-out branch — only pin/unpin is offered. */
  isCurrent: boolean;
}>();

const emit = defineEmits<{
  togglePin: [];
  toggleArchive: [];
  togglePreview: [];
  openWorktree: [];
  deleteBranch: [];
}>();

const { t } = useI18n();
</script>

<template>
  <span class="bp-item-actions" @click.stop>
    <button
      class="bp-item-action"
      :class="{ 'bp-item-action--active': pinned }"
      :title="pinned ? t('branch.unpin') : t('branch.pin')"
      @click.stop="emit('togglePin')"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" :fill="pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
        <path d="M8 1l2 4.5 5 .5-3.7 3.3L12.5 15 8 12.3 3.5 15l1.2-5.7L1 6l5-.5z" stroke-linejoin="round"/>
      </svg>
    </button>
    <button
      v-if="!isCurrent"
      class="bp-item-action"
      :class="{ 'bp-item-action--active': archived }"
      :title="archived ? t('branch.unarchive') : t('branch.archive')"
      @click.stop="emit('toggleArchive')"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
        <path d="M1.5 2.5h13v3h-13zM2.5 5.5h11v8h-11z" stroke-linejoin="round"/>
        <path d="M6.5 8.5h3" stroke-linecap="round"/>
      </svg>
    </button>
    <button
      v-if="!isCurrent"
      class="bp-item-action"
      :class="{ 'bp-item-action--active': previewing }"
      :title="t('branches.previewMerge')"
      @click.stop="emit('togglePreview')"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
    <button
      v-if="!isCurrent"
      class="bp-item-action"
      :title="t('worktree.openInWorktreeTabTooltip')"
      @click.stop="emit('openWorktree')"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" />
        <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" />
        <rect x="5.5" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" />
        <path d="M4.5 7v1.5M11.5 7v1.5M4.5 8.5h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>
    <button
      v-if="!isCurrent"
      class="bp-item-action bp-item-action--danger"
      :title="t('branches.deleteLabel')"
      @click.stop="emit('deleteBranch')"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </span>
</template>

<style scoped>
/* Fused action group — reads as one segmented control. Always visible. */
.bp-item-actions {
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
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
</style>
