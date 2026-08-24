<script setup lang="ts">
import { ref } from "vue";
import { useUndoToast } from "../composables/useUndoToast";
import { useTimeMachine } from "../composables/useTimeMachine";
import { useI18n } from "../composables/useI18n";

/**
 * Undo affordance shown right after a destructive operation (v3.8).
 *
 * It exists to teach ⌘Z: the button and the shortcut run the same code. The
 * snapshot engine only helps users who know it is there, and a discard gave
 * no feedback at all before this.
 */

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "restored"): void;
}>();

const { t } = useI18n();
const toast = useUndoToast();
const tm = useTimeMachine();
const busy = ref(false);

async function onUndo() {
  if (busy.value) return;
  busy.value = true;
  try {
    await tm.undoLast(props.cwd);
    emit("restored");
  } catch {
    // lastError surfaces in the popover and the modal; the toast just closes.
  } finally {
    busy.value = false;
    toast.dismiss();
  }
}
</script>

<template>
  <div v-if="toast.offer.value" :key="toast.offer.value.id" class="undo-toast" role="status">
    <svg class="undo-toast__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.4" />
      <path d="M3.5 3v3.5H7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M3.5 6.5A6 6 0 019 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <span class="undo-toast__msg">{{ toast.offer.value.message }}</span>
    <button class="undo-toast__btn" :disabled="busy" @click="onUndo">
      {{ t('timeMachine.toastUndo') }}
    </button>
    <span class="undo-toast__kbd mono">⌘Z</span>
    <button class="undo-toast__close" :aria-label="t('common.close')" @click="toast.dismiss()">×</button>
  </div>
</template>

<style scoped>
/* Sits just above the floating AppDock (v2.24.0), which anchors at
   `bottom: var(--space-4)` with a ~44px pill. */
.undo-toast {
  position: absolute;
  left: 50%;
  bottom: calc(var(--space-4, 12px) + 56px);
  transform: translateX(-50%);
  z-index: 51;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 6px);
  font-size: 12px;
  color: var(--color-text);
  animation: undo-toast-in 0.16s ease-out;
}

.undo-toast__icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.undo-toast__msg { white-space: nowrap; }

.undo-toast__btn {
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm, 4px);
  background: none;
  color: var(--color-accent);
  cursor: pointer;
}

.undo-toast__btn:hover:not(:disabled) { background: var(--color-bg-hover); }
.undo-toast__btn:disabled { opacity: 0.5; cursor: default; }

.undo-toast__kbd { font-size: 11px; color: var(--color-text-subtle); }

.undo-toast__close {
  border: none;
  background: none;
  color: var(--color-text-subtle);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}

@keyframes undo-toast-in {
  from { opacity: 0; transform: translate(-50%, 6px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
</style>
