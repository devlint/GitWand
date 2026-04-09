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
  animation: eco-fade 0.12s ease-out;
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
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  animation: eco-slide 0.15s ease-out;
}

@keyframes eco-slide {
  from { opacity: 0; transform: translateY(-8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.eco-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--color-border);
}

.eco-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  flex: 1;
}

.eco-hash {
  font-size: 11px;
  color: var(--color-accent);
  background: var(--color-bg-tertiary);
  padding: 2px 7px;
  border-radius: 4px;
}

.eco-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--color-text-muted);
  background: none;
  transition: color 0.1s, background 0.1s;
}

.eco-close:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.eco-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.eco-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.eco-label--optional {
  margin-top: 10px;
}

.eco-label-hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.6;
}

.eco-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  outline: none;
  resize: none;
  line-height: 1.5;
  box-sizing: border-box;
  transition: border-color 0.12s;
  font-family: var(--font-sans);
}

.eco-input--summary {
  font-weight: 500;
}

.eco-input:focus {
  border-color: var(--color-accent);
}

.eco-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
}

.eco-hint {
  font-size: 11px;
}

.eco-actions {
  display: flex;
  gap: 8px;
}

.eco-btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  transition: background 0.12s, opacity 0.12s;
}

.eco-btn--cancel {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.eco-btn--cancel:hover {
  background: var(--color-border);
}

.eco-btn--confirm {
  background: var(--color-accent);
  color: #fff;
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
