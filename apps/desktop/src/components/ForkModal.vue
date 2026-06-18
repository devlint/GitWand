<script setup lang="ts">
/**
 * ForkModal — `gh repo fork <url> --clone --remote-name=upstream` flow.
 *
 * Identical shape to CloneModal but routes through the GitHub CLI: forks
 * the upstream repo on the user's account first, then clones the fork
 * with `upstream` set as the secondary remote (origin = the user's fork).
 *
 * Requires `gh` to be installed and authenticated. Errors from gh come
 * back verbatim in the error pane.
 */
import { computed, onMounted, nextTick, ref } from "vue";
import { useI18n } from "../composables/useI18n";
import { ghFork, pickFolder } from "../utils/backend";
import { requireOnline } from "../utils/networkGuard";
import BaseModal from "./BaseModal.vue";

const emit = defineEmits<{
  close: [];
  forked: [path: string];
}>();

const { t } = useI18n();

const url = ref("");
const parentDir = ref("");
const isForking = ref(false);
const error = ref<string | null>(null);
const urlInputEl = ref<HTMLInputElement | null>(null);

const repoName = computed(() => {
  const trimmed = url.value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[/:]/);
  return parts[parts.length - 1] ?? "";
});

const destination = computed(() => {
  if (!parentDir.value || !repoName.value) return "";
  return `${parentDir.value.replace(/\/+$/, "")}/${repoName.value}`;
});

const canFork = computed(
  () => !isForking.value && url.value.trim().length > 0 && parentDir.value.length > 0 && repoName.value.length > 0,
);

async function browseForParent() {
  const path = await pickFolder();
  if (path) parentDir.value = path;
}

async function onFork() {
  if (!canFork.value) return;
  if (!(await requireOnline("fork"))) {
    error.value = t("connectivity.offline.disabledOp");
    return;
  }
  error.value = null;
  isForking.value = true;
  try {
    const finalPath = await ghFork(url.value.trim(), parentDir.value);
    emit("forked", finalPath);
    emit("close");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    isForking.value = false;
  }
}

function onCancel() {
  if (isForking.value) return;
  emit("close");
}

onMounted(() => {
  nextTick(() => urlInputEl.value?.focus());
});
</script>

<template>
  <BaseModal size="md" :title="t('fork.title')" @close="onCancel">
    <template #title-icon>
      <span class="fm-icon" aria-hidden="true">
        <!-- "Fork" glyph: three nodes branching -->
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <circle cx="18" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <circle cx="12" cy="19" r="2.2" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M6 7.2v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
          <path d="M12 13.2v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </span>
    </template>

    <form class="fm-form" @submit.prevent="onFork">
      <p class="fm-hint">{{ t("fork.hint") }}</p>

      <div class="fm-field">
        <label class="fm-label" for="fm-url">{{ t("fork.urlLabel") }}</label>
        <input
          id="fm-url"
          ref="urlInputEl"
          v-model="url"
          type="text"
          class="fm-input mono"
          :placeholder="t('fork.urlPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          :disabled="isForking"
        />
      </div>

      <div class="fm-field">
        <label class="fm-label" for="fm-parent">{{ t("fork.parentLabel") }}</label>
        <div class="fm-parent-row">
          <input
            id="fm-parent"
            v-model="parentDir"
            type="text"
            class="fm-input mono"
            :placeholder="t('fork.parentPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            :disabled="isForking"
          />
          <button
            type="button"
            class="fm-browse"
            :disabled="isForking"
            @click="browseForParent"
          >
            {{ t("fork.browse") }}
          </button>
        </div>
      </div>

      <p v-if="destination" class="fm-dest">
        {{ t("fork.willForkInto") }}
        <span class="mono fm-dest-path">{{ destination }}</span>
      </p>

      <p v-if="error" class="fm-error" role="alert">{{ error }}</p>

      <button type="submit" hidden></button>
    </form>

    <template #footer>
      <button
        type="button"
        class="bm-btn bm-btn--ghost"
        :disabled="isForking"
        @click="onCancel"
      >
        {{ t("common.cancel") }}
      </button>
      <button
        type="button"
        class="bm-btn bm-btn--primary"
        :disabled="!canFork"
        @click="onFork"
      >
        <span v-if="isForking" class="fm-spinner" aria-hidden="true"></span>
        {{ isForking ? t("fork.forking") : t("fork.forkButton") }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.fm-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}

.fm-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.fm-hint {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: var(--line-height-relaxed);
}

.fm-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.fm-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: var(--line-height-snug);
}

.fm-input {
  width: 100%;
  padding: var(--space-3) var(--space-5);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text);
  font-size: var(--font-size-md);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.fm-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.fm-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.fm-parent-row {
  display: flex;
  gap: var(--space-3);
}

.fm-parent-row .fm-input {
  flex: 1;
  min-width: 0;
}

.fm-browse {
  padding: var(--space-3) var(--space-5);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
  white-space: nowrap;
}

.fm-browse:hover:not(:disabled) {
  background: var(--color-bg-secondary);
}

.fm-browse:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fm-dest {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin: 0;
  line-height: var(--line-height-snug);
}

.fm-dest-path {
  color: var(--color-text);
  word-break: break-all;
}

.fm-error {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft, rgba(220, 38, 38, 0.08));
  border: 1px solid var(--color-danger, #dc2626);
  border-radius: var(--radius-md);
  color: var(--color-danger, #dc2626);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-snug);
  white-space: pre-wrap;
}

.fm-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: var(--space-2);
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: fm-spin 0.7s linear infinite;
  vertical-align: -1px;
}

@keyframes fm-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fm-spinner {
    animation: none;
  }
}
</style>
