<script setup lang="ts">
import { useI18n } from "@/composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = defineProps<{
  resolutions: Array<{ hunkIndex: number; resolvedLines: string[] }>;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const { t } = useI18n();
</script>

<template>
  <BaseModal :title="t('merge.resolveAutoSummaryTitle')" size="md" role="dialog" @close="emit('cancel')">
    <p class="rasm-body">{{ t('merge.resolveAutoSummaryBody', props.resolutions.length) }}</p>
    <div class="rasm-list">
      <div v-for="r in props.resolutions" :key="r.hunkIndex" class="rasm-item">
        <pre class="rasm-preview">{{ r.resolvedLines.join('\n') }}</pre>
      </div>
    </div>
    <template #footer>
      <button class="bm-btn bm-btn--ghost" @click="emit('cancel')">
        {{ t('merge.resolveAutoSummaryCancel') }}
      </button>
      <button class="bm-btn bm-btn--primary" @click="emit('confirm')">
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
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.rasm-preview {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 8px;
  margin: 0;
  overflow-x: auto;
}
</style>
