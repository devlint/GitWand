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
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="24" fill="var(--color-success-bg, rgba(16,185,129,0.12))" />
            <path
              d="M15 24.5l6 6L33 18"
              stroke="var(--color-success, #10B981)"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
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
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s ease;
}

.modal {
  background: var(--color-bg-elevated, #1e1e2e);
  border: 1px solid var(--color-border, rgba(255,255,255,0.08));
  border-radius: 16px;
  padding: 32px;
  width: 380px;
  max-width: 90vw;
  text-align: center;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  animation: scaleIn 0.2s ease;
}

.modal-icon {
  margin-bottom: 16px;
}

.modal-title {
  font-size: var(--font-size-lg, 16px);
  font-weight: 600;
  color: var(--color-text-primary, #e2e8f0);
  margin: 0 0 8px;
}

.modal-desc {
  font-size: var(--font-size-sm, 12px);
  color: var(--color-text-secondary, #94a3b8);
  margin: 0 0 24px;
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border-radius: 8px;
  font-size: var(--font-size-sm, 12px);
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.15s ease;
}

.btn--ghost {
  background: transparent;
  color: var(--color-text-secondary, #94a3b8);
  border: 1px solid var(--color-border, rgba(255,255,255,0.08));
}
.btn--ghost:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.04));
  color: var(--color-text-primary, #e2e8f0);
}

.btn--primary {
  background: var(--color-accent, #7C3AED);
  color: #fff;
}
.btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover, #6D28D9);
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
