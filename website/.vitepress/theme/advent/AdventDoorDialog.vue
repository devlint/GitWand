<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AdventDoor } from '@gitwand/advent'
import AdventInline from './AdventInline.vue'

const props = defineProps<{ door: AdventDoor | null }>()
const emit = defineEmits<{ close: [] }>()

const DOWNLOAD_URL = 'https://github.com/devlint/GitWand/releases/latest'
const TITLE_ID = 'advent-door-title'

const dialogEl = ref<HTMLDialogElement | null>(null)
const preEl = ref<HTMLElement | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.door,
  async (door) => {
    copied.value = false
    await nextTick()
    const el = dialogEl.value
    if (!el) return
    if (door && !el.open) el.showModal()
    else if (!door && el.open) el.close()
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

function selectSnippet(): void {
  const pre = preEl.value
  const selection = window.getSelection()
  if (!pre || !selection) return
  const range = document.createRange()
  range.selectNodeContents(pre)
  selection.removeAllRanges()
  selection.addRange(range)
}

async function copySnippet(): Promise<void> {
  if (!props.door) return
  try {
    await navigator.clipboard.writeText(props.door.snippet)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    selectSnippet()
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer))
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
      <p class="adv-dialog__day">Day {{ door.day }}</p>
      <h2 :id="TITLE_ID" class="adv-dialog__title">{{ door.command }}</h2>
      <p class="adv-dialog__problem">“<AdventInline :text="door.problem" />”</p>

      <div class="adv-dialog__snippet">
        <pre ref="preEl"><code>{{ door.snippet }}</code></pre>
        <button type="button" class="adv-dialog__copy" @click="copySnippet">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>

      <p class="adv-dialog__explanation"><AdventInline :text="door.explanation" /></p>

      <p v-if="door.tip" class="adv-dialog__tip">
        <span class="adv-dialog__wand" aria-hidden="true">🪄</span>
        <span><AdventInline :text="door.tip" /></span>
      </p>

      <p v-if="door.readMore" class="adv-dialog__more">
        <a :href="door.readMore">Read more</a>
      </p>

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
.adv-dialog__day {
  margin: 0 0 6px;
  font-family: var(--nc-font-mono);
  font-size: 11.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nc-waiting);
}
.adv-dialog__title {
  margin: 0 0 14px;
  font-family: var(--nc-font-mono);
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--nc-accent-100);
  border: 0;
  padding: 0;
}
.adv-dialog__problem {
  margin: 0 0 18px;
  font-size: 16px;
  font-style: italic;
  line-height: 1.6;
  color: var(--nc-neutral-300);
}
.adv-dialog__snippet {
  position: relative;
  margin: 0 0 18px;
}
.adv-dialog__snippet pre {
  margin: 0;
  padding: 14px 84px 14px 16px;
  overflow-x: auto;
  background: var(--nc-canvas);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-md);
  font-family: var(--nc-font-mono);
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--nc-settled);
  white-space: pre;
}
.adv-dialog__snippet code {
  font-family: inherit;
  background: none;
  padding: 0;
  color: inherit;
}
.adv-dialog__copy {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 10px;
  font-family: var(--nc-font-sans);
  font-size: 12px;
  font-weight: 500;
  color: var(--nc-neutral-300);
  background: var(--nc-surface);
  border: 1px solid var(--nc-neutral-700);
  border-radius: var(--nc-radius-sm);
  cursor: pointer;
}
.adv-dialog__copy:hover {
  color: var(--nc-accent-100);
  border-color: var(--nc-accent-600);
}
.adv-dialog__explanation {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--nc-neutral-200);
}
.adv-dialog__tip {
  display: flex;
  gap: 10px;
  margin: 0 0 16px;
  padding: 12px 14px;
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--nc-neutral-200);
  background: color-mix(in srgb, var(--nc-accent) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--nc-accent) 24%, transparent);
  border-radius: var(--nc-radius-md);
}
.adv-dialog__wand {
  flex: none;
}
.adv-dialog__more {
  margin: 0 0 16px;
  font-size: 14.5px;
}
.adv-dialog__more a {
  color: var(--nc-accent-300);
  text-underline-offset: 3px;
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
.adv-dialog__copy:focus-visible,
.adv-dialog__close:focus-visible,
.adv-dialog a:focus-visible {
  outline: 2px solid var(--nc-accent-300);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .adv-dialog__body {
    padding: 22px 18px 18px;
  }
  .adv-dialog__title {
    font-size: 20px;
  }
}
</style>
