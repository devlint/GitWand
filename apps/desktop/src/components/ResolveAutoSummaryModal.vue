<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@/composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = defineProps<{
  /**
   * Every resolution the engine offered, each flagged with whether it is
   * currently going to be applied. Rows the user unticks, and rows held back
   * by the confidence bar, stay listed rather than vanishing: the point of
   * this modal is to show what will happen, which includes what will not.
   */
  resolutions: Array<{
    hunkIndex: number;
    resolvedLines: string[];
    score: number;
    label: string;
    excluded: boolean;
  }>;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
  toggle: [hunkIndex: number];
}>();

const { t } = useI18n();

/** How many rows will actually be written if the user confirms. */
const appliedCount = computed(() => props.resolutions.filter((r) => !r.excluded).length);
</script>

<template>
  <BaseModal :title="t('merge.resolveAutoSummaryTitle')" size="md" role="dialog" @close="emit('cancel')">
    <p class="rasm-body">{{ t('merge.resolveAutoSummaryBody', appliedCount) }}</p>
    <div class="rasm-list">
      <label
        v-for="r in props.resolutions"
        :key="r.hunkIndex"
        class="rasm-item"
        :class="{ 'rasm-item--excluded': r.excluded }"
      >
        <div class="rasm-head">
          <input
            type="checkbox"
            class="rasm-check"
            :checked="!r.excluded"
            :aria-label="t('merge.resolveAutoSummaryToggle', String(r.hunkIndex + 1))"
            @change="emit('toggle', r.hunkIndex)"
          />
          <span class="rasm-line">{{ t('mergePreview.hunkLine') }} {{ r.hunkIndex + 1 }}</span>
          <span class="rasm-score" :class="`rasm-score--${r.label}`">{{ r.score }}%</span>
        </div>
        <pre class="rasm-preview">{{ r.resolvedLines.join('\n') }}</pre>
      </label>
    </div>
    <template #footer>
      <button class="bm-btn bm-btn--ghost" @click="emit('cancel')">
        {{ t('merge.resolveAutoSummaryCancel') }}
      </button>
      <button
        class="bm-btn bm-btn--primary"
        :disabled="appliedCount === 0"
        @click="emit('confirm')"
      >
        {{ t('merge.resolveAutoSummaryConfirm') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.rasm-body {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.rasm-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.rasm-item {
  display: block;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.rasm-item--excluded {
  opacity: 0.55;
}
.rasm-item--excluded .rasm-preview {
  text-decoration: line-through;
}
.rasm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
}
.rasm-check {
  cursor: pointer;
}
.rasm-line {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.rasm-score {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}
.rasm-score--certain,
.rasm-score--high {
  color: var(--color-success);
}
.rasm-score--medium {
  color: var(--color-warning);
}
.rasm-preview {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 8px;
  margin: 0;
  overflow-x: auto;
}
</style>
