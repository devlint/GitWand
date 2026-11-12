<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { AdventDoor } from '@gitwand/advent'
import { DOWNLOAD_URL } from './advent-state'
import AdventDoorContent from './AdventDoorContent.vue'

const props = defineProps<{ door: AdventDoor | null }>()
const emit = defineEmits<{ close: [] }>()

const TITLE_ID = 'advent-door-title'

const dialogEl = ref<HTMLDialogElement | null>(null)
const contentEl = ref<InstanceType<typeof AdventDoorContent> | null>(null)

watch(
  () => props.door,
  async (door) => {
    await nextTick()
    const el = dialogEl.value
    if (!el) return
    if (door && !el.open) {
      el.showModal()
      // Initial focus is always the title (tabindex="-1"): it sits at the top,
      // so nothing scrolls, and the browser's own pick (the first focusable,
      // possibly the scrollable snippet) never gets a focus ring on open.
      contentEl.value?.focusTitle()
    } else if (!door && el.open) el.close()
  },
)

/** Native close (Esc, the Close button, a backdrop click) tells the parent. */
function onNativeClose(): void {
  emit('close')
}

function close(): void {
  dialogEl.value?.close()
}

// Backdrop close: both the press and the release must land outside the
// dialog box. A text selection dragged out of the body, or a click on the
// dialog's own scrollbar, also targets the <dialog> but must not close it.
let pressStartedOutside = false

function outsideDialog(event: MouseEvent): boolean {
  const el = dialogEl.value
  if (!el || event.target !== el) return false
  const r = el.getBoundingClientRect()
  return (
    event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom
  )
}

function onDialogPointerDown(event: PointerEvent): void {
  pressStartedOutside = outsideDialog(event)
}

function onDialogClick(event: MouseEvent): void {
  const startedOutside = pressStartedOutside
  pressStartedOutside = false
  if (startedOutside && outsideDialog(event)) close()
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="adv-dialog"
    :aria-labelledby="TITLE_ID"
    @close="onNativeClose"
    @pointerdown="onDialogPointerDown"
    @click="onDialogClick"
  >
    <div v-if="door" class="adv-dialog__body">
      <AdventDoorContent ref="contentEl" :door="door" :title-id="TITLE_ID" />

      <div class="adv-dialog__footer">
        <a class="adv-dialog__download" :href="DOWNLOAD_URL">Download GitWand</a>
        <button type="button" class="adv-dialog__close" @click="close">Close</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.adv-dialog {
  padding: 0;
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  color: var(--nc-text);
  background: var(--nc-bg);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-xl);
  box-shadow: var(--nc-shadow-lg), var(--nc-glow-soft);
  font-family: var(--nc-font-sans);
}
.adv-dialog::backdrop {
  background: color-mix(in srgb, var(--nc-canvas) 78%, transparent);
  backdrop-filter: blur(4px);
}
.adv-dialog__body {
  padding: 28px 28px 22px;
}
.adv-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--nc-rule);
}
.adv-dialog__download {
  font-size: 13px;
  color: var(--nc-neutral-400);
  text-decoration: none;
}
.adv-dialog__download:hover {
  color: var(--nc-accent-300);
}
.adv-dialog__close {
  padding: 7px 16px;
  font-family: var(--nc-font-sans);
  font-size: 14px;
  font-weight: 500;
  color: var(--nc-accent-100);
  background: var(--nc-accent-800);
  border: 1px solid var(--nc-accent-700);
  border-radius: var(--nc-radius-md);
  cursor: pointer;
}
.adv-dialog__close:hover {
  background: var(--nc-accent-700);
}
.adv-dialog__close:focus-visible,
.adv-dialog__download:focus-visible {
  outline: 2px solid var(--nc-accent-300);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .adv-dialog__body {
    padding: 22px 18px 18px;
  }
}
</style>
