<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { AdventDoor } from '@gitwand/advent'
import AdventInline from './AdventInline.vue'

/**
 * A door's full content: day, command, problem, snippet (with Copy),
 * explanation, tip and read-more link. Shared by the door dialog and by the
 * article a day page shows once the season is over.
 */
const props = defineProps<{ door: AdventDoor; titleId: string }>()

const titleEl = ref<HTMLElement | null>(null)
const preEl = ref<HTMLElement | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.door,
  () => {
    clearTimeout(copiedTimer)
    copied.value = false
  },
)

function focusTitle(): void {
  titleEl.value?.focus({ preventScroll: true })
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

defineExpose({ focusTitle })
</script>

<template>
  <p class="adv-content__day">Day {{ door.day }}</p>
  <h2 :id="titleId" ref="titleEl" class="adv-content__title" tabindex="-1">{{ door.command }}</h2>
  <p class="adv-content__problem">“<AdventInline :text="door.problem" />”</p>

  <div class="adv-content__snippet">
    <div class="adv-content__snippet-bar">
      <button type="button" class="adv-content__copy" @click="copySnippet">
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </div>
    <pre ref="preEl"><code>{{ door.snippet }}</code></pre>
  </div>

  <p class="adv-content__explanation"><AdventInline :text="door.explanation" /></p>

  <p v-if="door.tip" class="adv-content__tip">
    <span class="adv-content__wand" aria-hidden="true">🪄</span>
    <span><AdventInline :text="door.tip" /></span>
  </p>

  <p v-if="door.readMore" class="adv-content__more">
    <a :href="door.readMore">Read more</a>
  </p>
</template>

<style scoped>
.adv-content__day {
  margin: 0 0 6px;
  font-family: var(--nc-font-mono);
  font-size: 11.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nc-waiting);
}
.adv-content__title {
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
.adv-content__title:focus {
  /* Programmatic focus only (tabindex="-1"): no ring on a heading. */
  outline: none;
}
.adv-content__problem {
  margin: 0 0 18px;
  font-size: 16px;
  font-style: italic;
  line-height: 1.6;
  color: var(--nc-neutral-300);
}
/* The Copy button lives in a bar above the code, never over it, so a long
   command scrolls horizontally without anything covering it. */
.adv-content__snippet {
  margin: 0 0 18px;
  background: var(--nc-canvas);
  border: 1px solid var(--nc-neutral-800);
  border-radius: var(--nc-radius-md);
  overflow: hidden;
}
.adv-content__snippet-bar {
  display: flex;
  justify-content: flex-end;
  padding: 6px 8px;
  border-bottom: 1px solid var(--nc-rule);
}
.adv-content__snippet pre {
  margin: 0;
  padding: 12px 16px 14px;
  overflow-x: auto;
  background: none;
  border: 0;
  border-radius: 0 0 var(--nc-radius-md) var(--nc-radius-md);
  font-family: var(--nc-font-mono);
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--nc-settled);
  white-space: pre;
}
.adv-content__snippet code {
  font-family: inherit;
  background: none;
  padding: 0;
  color: inherit;
}
.adv-content__copy {
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
.adv-content__copy:hover {
  color: var(--nc-accent-100);
  border-color: var(--nc-accent-600);
}
.adv-content__explanation {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--nc-neutral-200);
}
.adv-content__tip {
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
.adv-content__wand {
  flex: none;
}
.adv-content__more {
  margin: 0 0 16px;
  font-size: 14.5px;
}
.adv-content__more a {
  color: var(--nc-accent-300);
  text-underline-offset: 3px;
}
.adv-content__snippet pre:focus {
  outline: none;
}
/* A scrollable <pre> is keyboard-focusable: an inset ring that stays inside the frame. */
.adv-content__snippet pre:focus-visible {
  outline: 2px solid var(--nc-accent-300);
  outline-offset: -2px;
}
.adv-content__copy:focus-visible,
.adv-content__more a:focus-visible {
  outline: 2px solid var(--nc-accent-300);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .adv-content__title {
    font-size: 20px;
  }
}
</style>
