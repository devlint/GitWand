<script setup lang="ts">
import type { TokenMergeTrace } from "@gitwand/core";
import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
  trace: TokenMergeTrace;
  hunkId: number;
  accepted?: boolean;
}>();

const emit = defineEmits<{
  accept: [hunkId: number];
  reject: [hunkId: number];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="token-merge-panel">
    <div class="token-merge-panel__header">
      <span class="token-merge-panel__title">{{ t('mergeEditor.tokenLevelMerge.title') }}</span>
    </div>
    <p class="token-merge-panel__summary">
      {{ t('mergeEditor.tokenLevelMerge.pass1Lines', props.trace.pass1Count) }}
      {{ t('mergeEditor.tokenLevelMerge.pass2Lines', props.trace.pass2Count) }}
    </p>
    <pre class="token-merge-panel__preview">{{ props.trace.mergedLines.join('\n') }}</pre>
    <div class="token-merge-panel__actions">
      <template v-if="!props.accepted">
        <button
          type="button"
          class="token-merge-panel__btn token-merge-panel__btn--accept"
          @click="emit('accept', props.hunkId)"
        >
          {{ t('mergeEditor.tokenLevelMerge.accept') }}
        </button>
        <button
          type="button"
          class="token-merge-panel__btn token-merge-panel__btn--reject"
          @click="emit('reject', props.hunkId)"
        >
          {{ t('mergeEditor.tokenLevelMerge.reject') }}
        </button>
      </template>
      <span v-else class="token-merge-panel__accepted-badge">
        {{ t('mergeEditor.tokenLevelMerge.accepted') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.token-merge-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  margin: 8px 0;
  background: var(--color-bg-secondary);
}
.token-merge-panel__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.token-merge-panel__title {
  font-weight: 600;
  font-size: 13px;
}
.token-merge-panel__summary {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0 0 8px 0;
}
.token-merge-panel__preview {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-bg-primary);
  border-radius: var(--radius-sm);
  padding: 8px;
  overflow-x: auto;
  margin: 0 0 8px 0;
}
.token-merge-panel__actions {
  display: flex;
  gap: 8px;
}
.token-merge-panel__btn {
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--color-border);
}
.token-merge-panel__btn--accept {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.token-merge-panel__btn--reject {
  background: transparent;
}
.token-merge-panel__accepted-badge {
  font-size: 12px;
  color: var(--color-success);
}
</style>
