<script setup lang="ts">
/**
 * AiTaskCloseModal — confirmation shown when closing an AI-task tab.
 *
 * Closing the tab removes the underlying `gitwand-scratch-*` worktree, so we
 * confirm first and offer to bring the work back. Three outcomes:
 *   - Merge back & close: overlay the scratch changes onto the origin checkout,
 *     then remove the worktree.
 *   - Delete: discard the worktree (and its branch) — uncommitted work is lost.
 *   - Cancel: keep everything.
 *
 * Pure presentational: state + git work live in App.vue.
 */
import { computed } from "vue";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = withDefaults(
  defineProps<{
    /** Scratch branch name shown in the body for context. */
    branch: string;
    /** True while a delete/merge-back is in flight — disables the buttons. */
    busy?: boolean;
    /** Error message from a failed delete/merge-back, if any. */
    error?: string | null;
    /**
     * Which actions to offer:
     *   - "both"   → Delete + Merge back & Delete (scratch worktrees)
     *   - "delete" → Delete only (plain worktrees can't merge back)
     *   - "merge"  → Merge back & Delete only
     */
    mode?: "both" | "delete" | "merge";
  }>(),
  { mode: "both" },
);

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "delete"): void;
  (e: "merge-back"): void;
}>();

const { t } = useI18n();

const title = computed(() =>
  props.mode === "delete" ? t("aiTask.deleteTitle")
  : props.mode === "merge" ? t("aiTask.mergeTitle")
  : t("aiTask.closeTitle"),
);
</script>

<template>
  <BaseModal :title="title" size="sm" role="alertdialog" @close="emit('cancel')">
    <template #title-icon>
      <div class="atc-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M12 2v4M8 11V9a4 4 0 0 1 8 0v2" />
          <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none" />
          <path d="M9 20h6" />
        </svg>
      </div>
    </template>

    <p class="atc-desc">{{ t('aiTask.closeBody') }}</p>
    <p class="atc-branch">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="5" cy="3" r="1.5" />
        <circle cx="5" cy="13" r="1.5" />
        <circle cx="11" cy="6" r="1.5" />
        <path d="M5 4.5v7M5 4.5C5 7 11 7.5 11 6" />
      </svg>
      <span class="atc-branch-name">{{ branch }}</span>
    </p>
    <p v-if="mode !== 'merge'" class="atc-warn">
      {{ mode === 'both' ? t('aiTask.closeWarn') : t('aiTask.deleteWarn') }}
    </p>

    <p v-if="error" class="atc-error">{{ error }}</p>

    <template #footer>
      <button class="bm-btn bm-btn--ghost" :disabled="busy" @click="emit('cancel')">
        {{ t('aiTask.cancel') }}
      </button>
      <button v-if="mode !== 'merge'" class="bm-btn bm-btn--danger" :disabled="busy" @click="emit('delete')">
        {{ busy && mode === 'delete' ? t('aiTask.working') : t('aiTask.delete') }}
      </button>
      <button v-if="mode !== 'delete'" class="bm-btn bm-btn--primary" :disabled="busy" @click="emit('merge-back')">
        {{ busy ? t('aiTask.working') : t('aiTask.mergeBack') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.atc-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}

.atc-desc {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  line-height: 1.5;
}

.atc-branch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
}

.atc-branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.atc-warn {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.5;
}

.atc-error {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
}
</style>
