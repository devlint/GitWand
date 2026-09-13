<script setup lang="ts">
/**
 * v3.11.0 — a CodeMirror 6 editor as a `v-model` component.
 *
 * Thin on purpose: everything interesting lives in `useCodeMirror`. This layer
 * exists to turn an imperative view into a prop/emit pair, and there are
 * exactly two things it has to get right.
 *
 * **The inbound guard.** `watch(modelValue)` must compare against the live
 * document before writing, or the outbound emit re-enters as an inbound set
 * and the two sides ping-pong. The outbound side only fires on a real
 * `docChanged`, and `setDoc` is a no-op when the text already matches, so the
 * round trip terminates.
 *
 * **Accessibility goes on the contenteditable.** `aria-label` and `spellcheck`
 * are applied through `EditorView.contentAttributes`, not a wrapper `<div>`:
 * the contenteditable is the element a screen reader actually focuses, so a
 * label on an ancestor would not be announced.
 *
 * Sizing is CSS, not an extension: `minLines`/`maxLines` become a min/max
 * height with the scroller handling overflow. There is deliberately no
 * `resize: vertical` handle, which a CodeMirror view fights with its own
 * measurement loop.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useCodeMirror } from "@/composables/useCodeMirror";
import { loadCodeMirror } from "@/utils/codemirrorLibs";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Drives language detection. Null or omitted means plain text. */
    filePath?: string | null;
    readonly?: boolean;
    minLines?: number;
    maxLines?: number;
    autofocus?: boolean;
    ariaLabel?: string;
  }>(),
  { filePath: null, readonly: false, minLines: 8, maxLines: 24, autofocus: false, ariaLabel: "" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  ready: [];
}>();

const host = ref<HTMLElement | null>(null);
const editable = computed(() => !props.readonly);

const cm = useCodeMirror({
  host,
  editable,
  onDocChange: (doc) => {
    if (doc !== props.modelValue) emit("update:modelValue", doc);
  },
});

/** Attributes that belong on the contenteditable itself. */
async function contentAttributes() {
  const libs = await loadCodeMirror();
  return libs.EditorView.contentAttributes.of({
    "aria-label": props.ariaLabel || "Code editor",
    role: "textbox",
    "aria-multiline": "true",
    spellcheck: "false",
  });
}

async function mountEditor() {
  await cm.ensure();
  const state = await cm.buildState(props.modelValue, props.filePath, [await contentAttributes()]);
  if (!host.value) return;
  cm.mount(state);
  emit("ready");
  if (props.autofocus) cm.focus();
}

watch(host, (el) => { if (el) void mountEditor(); }, { immediate: true });

// Inbound sync. The `!==` comparison against the live doc is what stops the
// emit above from bouncing straight back in. Without it, an AI suggestion
// written into `modelValue` while the editor is open would loop.
watch(
  () => props.modelValue,
  (next) => { if (next !== cm.getDoc()) cm.setDoc(next); },
);

onBeforeUnmount(() => cm.destroy());

defineExpose({ focus: () => cm.focus(), view: cm.view });
</script>

<template>
  <div
    ref="host"
    class="code-editor"
    :style="{
      '--ce-min-height': `calc(${props.minLines} * 1.5em)`,
      '--ce-max-height': `calc(${props.maxLines} * 1.5em)`,
    }"
  ></div>
</template>

<style scoped>
.code-editor {
  width: 100%;
}
.code-editor :deep(.cm-editor) {
  min-height: var(--ce-min-height);
  max-height: var(--ce-max-height);
  font-family: var(--font-mono);
  font-size: 12px;
  tab-size: 2;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.code-editor :deep(.cm-editor.cm-focused) {
  /* CodeMirror draws its own focus ring; replace it with the app's. */
  outline: none;
  border-color: var(--color-accent);
}
.code-editor :deep(.cm-scroller) {
  overflow: auto;
}
</style>
