<script setup lang="ts">
/**
 * ModalCloseButton — the shared "X" close button for modal-like surfaces
 * (BaseModal header, HelpView header). Emits a plain click; the parent
 * decides what closing means. Extra attrs (title, …) fall through.
 */
import { useI18n } from "../composables/useI18n";

defineProps<{
  /** Accessible label. Defaults to the generic "Close". */
  label?: string;
}>();

const { t } = useI18n();
</script>

<template>
  <button class="modal-close-btn" type="button" :aria-label="label ?? t('common.close')">
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
      <path d="M5 5l6 6M11 5l-6 6" />
    </svg>
  </button>
</template>

<style scoped>
.modal-close-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  /* A third of the hover fill, so the button reads as a button at rest. */
  background: color-mix(in srgb, var(--color-bg-tertiary) 33%, transparent);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.modal-close-btn:hover {
  background: var(--color-bg-tertiary);
}
.modal-close-btn:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}
</style>
