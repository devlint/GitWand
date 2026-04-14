<script setup lang="ts">
import { ref, watch } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  entry: GitLogEntry | null;
}>();

const emit = defineEmits<{
  confirm: [summary: string, description: string];
  cancel: [];
}>();

const summary = ref("");
const description = ref("");
const summaryEl = ref<HTMLTextAreaElement | null>(null);

// Pré-remplir quand l'entrée change
watch(
  () => props.entry,
  (entry) => {
    if (!entry) return;
    // Le message contient le titre ; le body la description
    summary.value = entry.message;
    description.value = entry.body
      ? entry.body.replace(/\\n/g, "\n").trim()
      : "";
    // Focus au prochain tick
    setTimeout(() => summaryEl.value?.focus(), 50);
  },
  { immediate: true },
);

function handleConfirm() {
  if (!summary.value.trim()) return;
  emit("confirm", summary.value, description.value);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel");
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") handleConfirm();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="entry"
      class="eco-backdrop"
      @click.self="emit('cancel')"
      @keydown="handleKeydown"
    >
      <div class="eco-panel" role="dialog" aria-modal="true" :aria-label="t('log.editMessage')">
        <div class="eco-header">
          <span class="eco-title">{{ t('log.editMessage') }}</span>
          <span class="eco-hash mono">{{ entry.hash }}</span>
          <button class="eco-close" @click="emit('cancel')" :title="t('common.cancel')">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="eco-body">
          <label class="eco-label">{{ t('commit.summary') }}</label>
          <textarea
            ref="summaryEl"
            class="eco-input eco-input--summary mono"
            v-model="summary"
            rows="2"
            :placeholder="t('commit.summaryPlaceholder')"
            @keydown.ctrl.enter.prevent="handleConfirm"
            @keydown.meta.enter.prevent="handleConfirm"
            @keydown.escape.prevent="emit('cancel')"
          />

          <label class="eco-label eco-label--optional">
            {{ t('commit.description') }}
            <span class="eco-label-hint">{{ t('common.optional') }}</span>
          </label>
          <textarea
            class="eco-input eco-input--desc"
            v-model="description"
            rows="4"
            :placeholder="t('commit.descriptionPlaceholder')"
            @keydown.ctrl.enter.prevent="handleConfirm"
            @keydown.meta.enter.prevent="handleConfirm"
            @keydown.escape.prevent="emit('cancel')"
          />
        </div>

        <div class="eco-footer">
          <span class="eco-hint muted">{{ t('common.ctrlEnter') }}</span>
          <div class="eco-actions">
            <button class="eco-btn eco-btn--cancel" @click="emit('cancel')">
              {{ t('common.cancel') }}
            </button>
            <button
              class="eco-btn eco-btn--confirm"
              :disabled="!summary.trim()"
              @click="handleConfirm"
            >
              {{ t('log.amendConfirm') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.eco-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: eco-fade var(--transition-fast) ease-out;
}

@keyframes eco-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.eco-panel {
  width: 520px;
  max-width: calc(100vw - 48px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
  animation: eco-slide var(--transition-base) ease-out;
}

@keyframes eco-slide {
  from { opacity: 0; transform: translateY(-8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.eco-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.eco-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  flex: 1;
}

.eco-hash {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  background: var(--color-bg);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}

.eco-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: none;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.eco-close:hover {
  color: var(--color-text);
  background: var(--color-bg);
}

.eco-body {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.eco-label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.eco-label--optional {
  margin-top: var(--space-2);
}

.eco-label-hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.6;
}

.eco-input {
  width: 100%;
  padding: var(--space-2) var(--space-2);
  font-size: var(--font-size-md);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  resize: none;
  line-height: 1.5;
  box-sizing: border-box;
  transition: border-color var(--transition-fast);
  font-family: var(--font-sans);
}

.eco-input--summary {
  font-weight: 500;
}

.eco-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.eco-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border);
}

.eco-hint {
  font-size: var(--font-size-xs);
}

.eco-actions {
  display: flex;
  gap: var(--space-2);
}

.eco-btn {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  transition: background var(--transition-fast), opacity var(--transition-fast);
}

.eco-btn--cancel {
  background: var(--color-bg);
  color: var(--color-text);
}

.eco-btn--cancel:hover {
  background: var(--color-border);
}

.eco-btn--confirm {
  background: var(--color-accent);
  color: var(--color-accent-text);
}

.eco-btn--confirm:hover:not(:disabled) {
  background: var(--color-accent-hover, var(--color-accent));
  filter: brightness(1.1);
}

.eco-btn--confirm:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
