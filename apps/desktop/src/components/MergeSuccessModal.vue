<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const emit = defineEmits<{
  close: [];
  push: [];
}>();

const pushing = ref(false);

async function handlePush() {
  pushing.value = true;
  emit("push");
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true">

        <!-- Success icon -->
        <div class="modal-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <circle cx="24" cy="24" r="24" />
            <path d="M15 24.5l6 6L33 18" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>

        <h2 class="modal-title">{{ t('merge.successTitle') }}</h2>
        <p class="modal-desc">{{ t('merge.successDesc') }}</p>

        <div class="modal-actions">
          <button class="btn btn--ghost" @click="emit('close')">
            {{ t('merge.successClose') }}
          </button>
          <button class="btn btn--primary" @click="handlePush" :disabled="pushing">
            <svg v-if="!pushing" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 12V3M4 7l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M2 14h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            <span v-if="pushing" class="spinner"></span>
            {{ t('merge.successPush') }}
          </button>
        </div>

      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--color-overlay, rgba(0, 0, 0, 0.6));
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--transition-fast);
}

.modal {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  padding: var(--space-9);
  width: 380px;
  max-width: 90vw;
  text-align: center;
  box-shadow: var(--shadow-xl);
  animation: scaleIn 0.2s var(--ease-out);
}

.modal-icon {
  margin-bottom: var(--space-6);
}
.modal-icon svg circle {
  fill: var(--color-success-soft);
}
.modal-icon svg path {
  stroke: var(--color-success);
}

.modal-title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  margin: 0 0 var(--space-4);
}

.modal-desc {
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  margin: 0 0 var(--space-8);
  line-height: var(--line-height-normal);
}

.modal-actions {
  display: flex;
  gap: var(--space-5);
  justify-content: center;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-7);
  border-radius: var(--radius-md);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  border: none;
  transition: all var(--transition-base);
}

.btn--ghost {
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}
.btn--ghost:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border-color: var(--color-border-strong);
}

.btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
}
.btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
.btn--primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
