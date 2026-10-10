<script setup lang="ts">
/**
 * AiContextButton — "ctx" middle segment (sheet-with-plus icon) of an AI split button (between the
 * main Generate button and AiTemplateMenu's chevron). Opens a modal where the
 * user writes extra context for the selected template's prompt; the host
 * passes it to the generator (see useAiExtraContext).
 *
 * Like AiTemplateMenu's chevron, the host styles the button through
 * `buttonClass` (scoped parent styles reach it via `:deep()`).
 */
import { nextTick, onUnmounted, ref } from "vue";
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import { useAiExtraContext } from "../composables/useAiExtraContext";

const props = defineProps<{
  /** Which generator the context belongs to (see useAiExtraContext). */
  scope: string;
  cwd: string;
  disabled?: boolean;
  buttonClass?: string;
}>();

const { t } = useI18n();
const { context, setContext } = useAiExtraContext(() => props.scope, () => props.cwd);

const open = ref(false);
const draft = ref("");
const textarea = ref<HTMLTextAreaElement | null>(null);

/**
 * Capture phase on window, ahead of every BaseModal's own Escape listener:
 * the modal may sit on top of another one (release notes), and Escape must
 * close only this one.
 */
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  close();
}

function show() {
  draft.value = context.value;
  open.value = true;
  window.addEventListener("keydown", onKey, true);
  nextTick(() => textarea.value?.focus());
}

function close() {
  if (!open.value) return;
  open.value = false;
  window.removeEventListener("keydown", onKey, true);
}

function save() {
  setContext(draft.value);
  close();
}

function clear() {
  draft.value = "";
  setContext("");
  close();
}

/** ⌘/Ctrl+Enter saves, like submitting a commit message. */
function onTextareaKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    save();
  }
}

onUnmounted(close);
</script>

<template>
  <button
    type="button"
    class="aic-btn"
    :class="[buttonClass, { 'aic-btn--set': !!context }]"
    :disabled="disabled"
    v-tooltip="context ? t('settings.aiTemplates.ctxTooltipSet') : t('settings.aiTemplates.ctxTooltip')"
    :aria-label="t('settings.aiTemplates.ctxTitle')"
    @click.stop="show"
  >
    <!-- Note with text lines and a + in its corner: add context to the prompt -->
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M11 7.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h4"/>
      <path d="M5 5h3.5M5 8h2.5"/>
      <path d="M12.5 9.5v5M10 12h5"/>
    </svg><span v-if="context" class="aic-dot" aria-hidden="true"></span>
  </button>
  <BaseModal
    v-if="open"
    :title="t('settings.aiTemplates.ctxTitle')"
    size="md"
    @close="close"
  >
    <p class="aic-hint">{{ t('settings.aiTemplates.ctxHint') }}</p>
    <textarea
      ref="textarea"
      v-model="draft"
      class="aic-textarea"
      rows="8"
      :placeholder="t('settings.aiTemplates.ctxPlaceholder')"
      @keydown="onTextareaKey"
    ></textarea>
    <template #footer>
      <button v-if="context" type="button" class="bm-btn aic-clear" @click="clear">
        {{ t('settings.aiTemplates.ctxClear') }}
      </button>
      <button type="button" class="bm-btn" @click="close">{{ t('common.cancel') }}</button>
      <button type="button" class="bm-btn bm-btn--primary" @click="save">{{ t('common.save') }}</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.aic-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
/* Context set: a dot, so the button tells it before the tooltip does. */
.aic-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.aic-hint {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.aic-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-3);
  font-family: inherit;
  font-size: var(--font-size-base);
  line-height: 1.45;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  resize: vertical;
}
.aic-textarea:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
/* Clear sits on the left, away from Save. */
.aic-clear {
  margin-right: auto;
}
</style>
