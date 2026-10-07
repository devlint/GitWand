<script setup lang="ts">
/**
 * Shared branch-name entry used by every "create a branch" modal:
 * the commit-context "Create branch here…" dialog and the branch
 * selector's "+" dialog. Keeping the markup + styles here means a
 * tweak to the look or the AI strip lands in both places at once.
 */
import { useI18n } from "../composables/useI18n";
import AiSparkle from "./AiSparkle.vue";

withDefaults(
  defineProps<{
    /** Current branch name (v-model). */
    modelValue: string;
    /** Disables inputs while an async op (create / suggest) is in flight. */
    busy?: boolean;
    /** Error message rendered below the input. */
    error?: string;
    /** Show the AI suggestion strip. */
    aiAvailable?: boolean;
    /** True while an AI suggestion is being generated. */
    suggesting?: boolean;
    /** Hint text shown in the AI strip. Defaults to the generic branch hint. */
    hint?: string;
  }>(),
  {
    busy: false,
    error: "",
    aiAvailable: false,
    suggesting: false,
    hint: "",
  }
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "suggest"): void;
  (e: "submit"): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="bnf">
    <!-- AI suggestion strip -->
    <div v-if="aiAvailable" class="tag-ai-row">
      <span class="tag-ai-hint">{{ hint || t('branches.aiHint') }}</span>
      <button
        type="button"
        class="bm-btn btn--ai tag-ai-btn"
        :class="{ 'ai-loading': suggesting }"
        :disabled="busy || suggesting"
        :title="hint || t('branches.aiHint')"
        @click="emit('suggest')"
      >
        <AiSparkle :size="13" :animated="suggesting" />
        {{ suggesting ? t('common.generating') : t('commitCtx.tagAiSuggest') }}
      </button>
    </div>
    <input
      :value="modelValue"
      type="text"
      class="cam-input mono"
      :placeholder="t('branches.namePlaceholder')"
      maxlength="100"
      autofocus
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter.prevent="emit('submit')"
    />
    <p v-if="error" class="cam-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.bnf {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tag-ai-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-accent-soft, rgba(124, 58, 237, 0.08));
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-accent-muted, rgba(124, 58, 237, 0.2));
}

.tag-ai-hint {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  flex: 1;
}

.tag-ai-btn {
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-3);
  gap: var(--space-1);
  flex-shrink: 0;
}

/* Matches the commit-summary input: light bg, rounded, roomy padding. */
.cam-input {
  width: 100%;
  padding: var(--space-3) var(--space-5);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-md);
  line-height: 1.5;
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-hover);
}

.cam-input:focus {
  border-color: var(--color-accent);
}

.cam-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-danger, #ef4444);
}
</style>
