<script setup lang="ts">
import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
  resolvedLines: string[];
  hunkId: number;
  explanation: string;
  accepted?: boolean;
}>();

const emit = defineEmits<{
  accept: [hunkId: number];
  reject: [hunkId: number];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="resolution-preview-panel">
    <div class="resolution-preview-panel__header">
      <span class="resolution-preview-panel__title">{{ t('mergeEditor.resolutionPreview.title') }}</span>
    </div>
    <p class="resolution-preview-panel__explanation">{{ props.explanation }}</p>
    <pre class="resolution-preview-panel__preview">{{ props.resolvedLines.join('\n') }}</pre>
    <div class="resolution-preview-panel__actions">
      <template v-if="!props.accepted">
        <button
          type="button"
          class="resolution-preview-panel__btn resolution-preview-panel__btn--accept"
          @click="emit('accept', props.hunkId)"
        >
          {{ t('mergeEditor.resolutionPreview.accept') }}
        </button>
        <button
          type="button"
          class="resolution-preview-panel__btn resolution-preview-panel__btn--reject"
          @click="emit('reject', props.hunkId)"
        >
          {{ t('mergeEditor.resolutionPreview.reject') }}
        </button>
      </template>
      <span v-else class="resolution-preview-panel__accepted-badge">
        {{ t('mergeEditor.resolutionPreview.accepted') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.resolution-preview-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  margin: 8px 0;
  background: var(--color-bg-secondary);
}
.resolution-preview-panel__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.resolution-preview-panel__title {
  font-weight: 600;
  font-size: 13px;
}
.resolution-preview-panel__explanation {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0 0 8px 0;
}
.resolution-preview-panel__preview {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-bg-primary);
  border-radius: var(--radius-sm);
  padding: 8px;
  overflow-x: auto;
  margin: 0 0 8px 0;
}
.resolution-preview-panel__actions {
  display: flex;
  gap: 8px;
}
.resolution-preview-panel__btn {
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--color-border);
}
.resolution-preview-panel__btn--accept {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.resolution-preview-panel__btn--reject {
  background: transparent;
}
.resolution-preview-panel__accepted-badge {
  font-size: 12px;
  color: var(--color-success);
}
</style>
