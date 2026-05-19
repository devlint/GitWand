<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import {
  gitStashList,
  gitStash,
  gitStashPop,
  gitStashApply,
  gitStashDrop,
  gitStashShow,
  type StashEntry,
} from "../utils/backend";
import { useStashMessage } from "../composables/useStashMessage";
import { useAIProvider } from "../composables/useAIProvider";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";
import AiSparkle from "./AiSparkle.vue";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "close"): void;
}>();

const stashes = ref<StashEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const expandedIndex = ref<number | null>(null);
const expandedDiff = ref<string>("");

const composerOpen = ref(false);
const stashMessage = ref("");
const { isGenerating: isGeneratingMessage, generate: generateStashMessage } =
  useStashMessage();
const ai = useAIProvider();
const { locale, t } = useI18n();

async function loadStashes() {
  if (!props.cwd) return;
  loading.value = true;
  error.value = null;
  try {
    stashes.value = await gitStashList(props.cwd);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/stash.*:\s*404/i.test(msg)) {
      stashes.value = [];
    } else {
      error.value = msg;
    }
  } finally {
    loading.value = false;
  }
}

function openComposer() {
  stashMessage.value = "";
  error.value = null;
  composerOpen.value = true;
}

function closeComposer() {
  composerOpen.value = false;
  stashMessage.value = "";
}

async function suggestMessage() {
  if (!props.cwd) return;
  error.value = null;
  try {
    const suggestion = await generateStashMessage(props.cwd, {
      locale: locale.value,
    });
    if (suggestion) stashMessage.value = suggestion;
  } catch (err: any) {
    error.value = err.message;
  }
}

async function createStash() {
  if (!props.cwd) return;
  try {
    await gitStash(props.cwd, stashMessage.value);
    closeComposer();
    await loadStashes();
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  }
}

async function applyStash(index: number) {
  if (!props.cwd) return;
  try {
    await gitStashApply(props.cwd, index);
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  }
}

async function popStash() {
  if (!props.cwd) return;
  try {
    await gitStashPop(props.cwd);
    await loadStashes();
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  }
}

async function dropStash(index: number) {
  if (!props.cwd) return;
  try {
    await gitStashDrop(props.cwd, index);
    await loadStashes();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function toggleDiff(index: number) {
  if (expandedIndex.value === index) {
    expandedIndex.value = null;
    expandedDiff.value = "";
    return;
  }
  try {
    expandedDiff.value = await gitStashShow(props.cwd, index);
    expandedIndex.value = index;
  } catch (err: any) {
    error.value = err.message;
  }
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

onMounted(loadStashes);
watch(() => props.cwd, loadStashes);
</script>

<template>
  <BaseModal
    size="lg"
    :title="t('stash.title')"
    @close="emit('close')"
  >
    <template #title-icon>
      <span class="bm-title-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M3 7l9-4 9 4-9 4-9-4z"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M3 12l9 4 9-4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M3 17l9 4 9-4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </template>

    <template #header-actions>
      <div class="sm-header-actions">
        <button
          class="bm-btn bm-btn--primary sm-btn-sm"
          @click="openComposer"
          :disabled="composerOpen"
          :title="t('stash.createTooltip')"
        >
          {{ t('stash.createButtonShort') }}
        </button>
        <button
          class="bm-btn bm-btn--ghost sm-btn-sm"
          @click="popStash"
          :disabled="stashes.length === 0"
          :title="t('stash.popTooltip')"
        >
          {{ t('stash.popButton') }}
        </button>
      </div>
    </template>

    <div v-if="composerOpen" class="sm-composer">
      <input
        v-model="stashMessage"
        type="text"
        class="sm-composer-input"
        :placeholder="t('stash.composerPlaceholder')"
        maxlength="120"
        @keydown.enter.prevent="createStash"
        @keydown.esc.prevent="closeComposer"
      />
      <button
        v-if="ai.isAvailable.value"
        class="sm-btn sm-btn--ai"
        :disabled="isGeneratingMessage"
        @click="suggestMessage"
        :title="t('stash.aiSuggestTooltip')"
      >
        <span v-if="isGeneratingMessage">…</span>
        <span v-else class="sm-ai-label">
          <AiSparkle :size="13" />
          {{ t('stash.aiButton') }}
        </span>
      </button>
      <button class="bm-btn bm-btn--primary sm-btn-inline" @click="createStash">
        {{ t('stash.createButton') }}
      </button>
      <button class="bm-btn bm-btn--ghost sm-btn-inline" @click="closeComposer">
        {{ t('stash.cancelButton') }}
      </button>
    </div>

    <div v-if="error" class="sm-error">{{ error }}</div>

    <div v-if="loading" class="sm-loading">{{ t('stash.loading') }}</div>

    <div v-else-if="stashes.length === 0 && !composerOpen" class="sm-empty">
      {{ t('stash.empty') }} <strong>{{ t('stash.emptyAction') }}</strong> {{ t('stash.emptySuffix') }}
    </div>

    <div v-else-if="stashes.length > 0" class="sm-list">
      <div
        v-for="stash in stashes"
        :key="stash.index"
        class="sm-item"
        :class="{ 'sm-item--expanded': expandedIndex === stash.index }"
      >
        <div class="sm-item-header" @click="toggleDiff(stash.index)">
          <span class="sm-index">{{ stash.index }}</span>
          <div class="sm-info">
            <span class="sm-message">{{ stash.message }}</span>
            <span class="sm-meta">
              <span v-if="stash.branch" class="sm-branch">{{ stash.branch }}</span>
              <span class="sm-date">{{ formatDate(stash.date) }}</span>
            </span>
          </div>
          <div class="sm-item-actions" @click.stop>
            <button
              class="sm-btn-xs"
              @click="applyStash(stash.index)"
              :title="t('stash.applyTooltip')"
            >
              {{ t('stash.apply') }}
            </button>
            <button
              class="sm-btn-xs sm-btn-xs--danger"
              @click="dropStash(stash.index)"
              :title="t('stash.dropTooltip')"
            >
              {{ t('stash.drop') }}
            </button>
          </div>
        </div>
        <div v-if="expandedIndex === stash.index && expandedDiff" class="sm-diff">
          <pre>{{ expandedDiff }}</pre>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
/* .sm-title-icon removed — use global .bm-title-icon from BaseModal instead */

.sm-header-actions {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  align-self: center;
  flex-shrink: 0;
}

.sm-btn-sm {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  line-height: 1;
  height: 32px;
}

/* ── Composer ─────────────────────────────────────────── */
.sm-composer {
  display: flex;
  align-items: stretch;
  gap: var(--space-3);
  padding: var(--space-4);
  margin-bottom: var(--space-5);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.sm-composer-input {
  flex: 1;
  min-width: 0;
  height: 36px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text);
  font-size: var(--font-size-md);
  padding: 0 var(--space-5);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.sm-composer-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.sm-btn-inline {
  padding: var(--space-2) var(--space-5);
  font-size: var(--font-size-sm);
}

.sm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);
}

.sm-btn--ai {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border: 1px solid var(--color-accent);
}
.sm-btn--ai:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-accent-text);
}
.sm-btn--ai:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sm-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* ── Error / empty states ─────────────────────────────── */
.sm-error {
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
}

.sm-loading,
.sm-empty {
  padding: var(--space-9) var(--space-6);
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  text-align: center;
}

.sm-empty strong {
  color: var(--color-text);
}

/* ── List ─────────────────────────────────────────────── */
.sm-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sm-item {
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  overflow: hidden;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.sm-item:hover,
.sm-item--expanded {
  border-color: var(--color-accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.sm-item-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  cursor: pointer;
}

.sm-index {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  min-width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  padding: 0 var(--space-3);
  font-variant-numeric: tabular-nums;
}

.sm-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sm-message {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sm-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  display: flex;
  gap: var(--space-4);
}

.sm-branch {
  color: var(--color-accent);
  font-family: var(--font-mono, "JetBrains Mono", monospace);
}

.sm-item-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.sm-btn-xs {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);
}

.sm-btn-xs:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent);
}

.sm-btn-xs--danger:hover:not(:disabled) {
  background: var(--color-danger);
  color: #fff;
  border-color: var(--color-danger);
}

.sm-diff {
  border-top: 1px solid var(--color-border);
  padding: var(--space-4) var(--space-5);
  background: var(--color-bg-secondary);
  max-height: 240px;
  overflow: auto;
}

.sm-diff pre {
  margin: 0;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono, "JetBrains Mono", "Fira Code", monospace);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
</style>
