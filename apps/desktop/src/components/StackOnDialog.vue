<script setup lang="ts">
/**
 * StackOnDialog — pick the parent branch a branch is stacked on (v3.14).
 * Calls useStacks().stackOn itself and shows the backend's refusal inline:
 * the known `set_parent` refusals localized, anything else verbatim.
 */
import { computed, ref } from "vue";
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import { useStacks } from "../composables/useStacks";
import { stackOnRefusal } from "../utils/stackOnError";

const props = defineProps<{
  cwd: string;
  branch: string;
  candidates: string[];
  forge: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const stacks = useStacks();

const parent = ref(props.candidates[0] ?? "");
/**
 * The candidates, plus the chosen parent if a refresh (after a refusal, say)
 * dropped it: the select keeps the user's choice instead of going blank.
 */
const options = computed(() =>
  parent.value && !props.candidates.includes(parent.value) ? [...props.candidates, parent.value] : props.candidates,
);
/** Hidden until the forge is known (null), and for GitHub, which detects squash merges. */
const showForgeHint = computed(() => props.forge !== null && props.forge !== "github");
const busy = ref(false);
const error = ref<string | null>(null);

async function confirm() {
  if (!parent.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await stacks.stackOn(props.cwd, props.branch, parent.value);
    emit("close");
  } catch (e) {
    const raw = String((e as { message?: string })?.message ?? e);
    const known = stackOnRefusal(raw);
    error.value = known ? t(known.key, ...known.args) : raw;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <BaseModal :title="t('stacks.stackOn.title', branch)" size="sm" @close="emit('close')">
    <label class="sod-label" for="sod-parent">{{ t('stacks.stackOn.parent') }}</label>
    <select id="sod-parent" v-model="parent" class="sod-select mono" :disabled="busy">
      <option v-for="c in options" :key="c" :value="c">{{ c }}</option>
    </select>
    <p class="sod-hint">{{ t('stacks.stackOn.hint', branch) }}</p>
    <p v-if="showForgeHint" class="sod-hint">{{ t('stacks.stackOn.forgeHint') }}</p>
    <p v-if="candidates.length === 0" class="sod-hint">{{ t('stacks.stackOn.noCandidates') }}</p>
    <p v-if="error" class="sod-error" role="alert">{{ error }}</p>
    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button type="button" class="bm-btn bm-btn--primary" :disabled="busy || !parent" @click="confirm">
        {{ t('stacks.stackOn.confirm') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.sod-label {
  display: block;
  margin-bottom: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.sod-select {
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
}
.sod-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.sod-error {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-sm);
  color: var(--color-danger);
}
</style>
