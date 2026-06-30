<script setup lang="ts">
/**
 * AiTaskNameModal — prompt for the name of a new AI task.
 *
 * Shown before an AI task (a `gitwand-scratch-*` worktree) is created. The name
 * is slugified backend-side into the worktree/branch name
 * (`gitwand-scratch-<slug>`) so tasks are recognisable on disk and in the repo
 * tabs instead of an opaque timestamp. Leaving it blank falls back to the
 * timestamp naming.
 *
 * Pure presentational: the worktree creation lives in App.vue.
 */
import { ref, onMounted, nextTick } from "vue";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = defineProps<{
  /** True while the worktree is being created — disables the inputs. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "create", name: string): void;
}>();

const { t } = useI18n();

const name = ref("");
const inputEl = ref<HTMLInputElement | null>(null);

function onCreate() {
  if (props.busy) return;
  emit("create", name.value.trim());
}

onMounted(() => {
  nextTick(() => inputEl.value?.focus());
});
</script>

<template>
  <BaseModal :title="t('aiTask.nameTitle')" size="sm" @close="emit('cancel')">
    <template #title-icon>
      <div class="atn-icon">
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

    <p class="atn-desc">{{ t('aiTask.nameBody') }}</p>
    <input
      ref="inputEl"
      v-model="name"
      type="text"
      class="atn-input"
      :placeholder="t('aiTask.namePlaceholder')"
      :disabled="busy"
      maxlength="64"
      @keydown.enter.prevent="onCreate"
    />
    <p class="atn-hint">{{ t('aiTask.nameHint') }}</p>

    <template #footer>
      <button class="bm-btn bm-btn--ghost" :disabled="busy" @click="emit('cancel')">
        {{ t('aiTask.cancel') }}
      </button>
      <button class="bm-btn bm-btn--primary" :disabled="busy" @click="onCreate">
        {{ busy ? t('aiTask.working') : t('aiTask.create') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.atn-icon {
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

.atn-desc {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  line-height: 1.5;
}

.atn-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-md);
  color: var(--color-text);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.atn-input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.atn-input:disabled {
  opacity: 0.6;
}

.atn-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.5;
}
</style>
