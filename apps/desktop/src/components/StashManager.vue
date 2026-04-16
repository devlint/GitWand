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
const { locale } = useI18n();

async function loadStashes() {
  if (!props.cwd) return;
  loading.value = true;
  error.value = null;
  try {
    stashes.value = await gitStashList(props.cwd);
  } catch (err: any) {
    error.value = err.message;
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
  <div class="stash-manager">
    <div class="stash-header">
      <h3>📦 Stash Manager</h3>
      <div class="stash-actions">
        <button
          class="btn btn-sm btn-primary"
          @click="openComposer"
          :disabled="composerOpen"
          title="Stash all changes"
        >
          + Stash
        </button>
        <button
          class="btn btn-sm"
          @click="popStash"
          :disabled="stashes.length === 0"
          title="Pop most recent stash"
        >
          Pop
        </button>
        <button class="btn btn-sm btn-ghost" @click="$emit('close')" title="Close">✕</button>
      </div>
    </div>

    <div v-if="composerOpen" class="stash-composer">
      <input
        v-model="stashMessage"
        type="text"
        class="stash-composer-input"
        :placeholder="locale === 'fr' ? 'Message optionnel — laisse vide pour le label par défaut' : 'Optional message — leave empty for the default label'"
        maxlength="120"
        @keydown.enter.prevent="createStash"
        @keydown.esc.prevent="closeComposer"
      />
      <button
        v-if="ai.isAvailable.value"
        class="btn btn-xs btn-ai"
        :disabled="isGeneratingMessage"
        @click="suggestMessage"
        :title="locale === 'fr' ? 'Suggérer un message avec IA' : 'Suggest a message with AI'"
      >
        <span v-if="isGeneratingMessage">…</span>
        <span v-else>✨ {{ locale === 'fr' ? 'IA' : 'AI' }}</span>
      </button>
      <button class="btn btn-xs btn-primary" @click="createStash">
        {{ locale === 'fr' ? 'Stasher' : 'Stash' }}
      </button>
      <button class="btn btn-xs btn-ghost" @click="closeComposer">
        {{ locale === 'fr' ? 'Annuler' : 'Cancel' }}
      </button>
    </div>

    <div v-if="error" class="stash-error">{{ error }}</div>

    <div v-if="loading" class="stash-loading">Loading stashes…</div>

    <div v-else-if="stashes.length === 0" class="stash-empty">
      No stashes. Use <strong>+ Stash</strong> to save your current changes.
    </div>

    <div v-else class="stash-list">
      <div
        v-for="stash in stashes"
        :key="stash.index"
        class="stash-item"
        :class="{ expanded: expandedIndex === stash.index }"
      >
        <div class="stash-item-header" @click="toggleDiff(stash.index)">
          <span class="stash-index">{{ stash.index }}</span>
          <div class="stash-info">
            <span class="stash-message">{{ stash.message }}</span>
            <span class="stash-meta">
              <span v-if="stash.branch" class="stash-branch">{{ stash.branch }}</span>
              <span class="stash-date">{{ formatDate(stash.date) }}</span>
            </span>
          </div>
          <div class="stash-item-actions" @click.stop>
            <button
              class="btn btn-xs"
              @click="applyStash(stash.index)"
              title="Apply (keep stash)"
            >
              Apply
            </button>
            <button
              class="btn btn-xs btn-danger"
              @click="dropStash(stash.index)"
              title="Drop stash"
            >
              Drop
            </button>
          </div>
        </div>
        <div v-if="expandedIndex === stash.index && expandedDiff" class="stash-diff">
          <pre>{{ expandedDiff }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Full-height modal card. The outer .stash-overlay (in App.vue) handles
   the backdrop; here we only style the card itself. */
.stash-manager {
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  max-height: inherit;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.35));
  overflow: hidden;
}

.stash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

.stash-header h3 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.stash-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

/* ── Composer ─────────────────────────────────────────── */
.stash-composer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.stash-composer-input {
  flex: 1;
  min-width: 0;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  padding: 6px 10px;
  outline: none;
  transition: border-color var(--transition-fast);
}

.stash-composer-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

/* ── Error / empty states ─────────────────────────────── */
.stash-error {
  margin: 12px 18px 0;
  padding: 8px 12px;
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
}

.stash-loading,
.stash-empty {
  padding: 32px 24px;
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  text-align: center;
}

.stash-empty strong {
  color: var(--color-text);
}

/* ── List ─────────────────────────────────────────────── */
.stash-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stash-item {
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  overflow: hidden;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.stash-item:hover,
.stash-item.expanded {
  border-color: var(--color-accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.stash-item-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}

.stash-index {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  min-width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
}

.stash-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stash-message {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stash-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  display: flex;
  gap: 10px;
}

.stash-branch {
  color: var(--color-accent);
  font-family: var(--font-mono, "JetBrains Mono", monospace);
}

.stash-item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.stash-diff {
  border-top: 1px solid var(--color-border);
  padding: 10px 12px;
  background: var(--color-bg-secondary);
  max-height: 240px;
  overflow: auto;
}

.stash-diff pre {
  margin: 0;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono, "JetBrains Mono", "Fira Code", monospace);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

/* ── Buttons (scoped, deterministic) ─────────────────── */
/*
 * Each variant owns every property it needs at rest AND on hover.
 * We never rely on a base `.btn:hover` to set a property later
 * overridden by a variant — that's what was making
 * `.btn-primary:hover` invisible in the previous iteration.
 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  padding: 6px 12px;
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast), filter var(--transition-fast);
}

.btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: var(--color-accent);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm { padding: 5px 12px; font-size: var(--font-size-sm); }
.btn-xs { padding: 3px 8px; font-size: var(--font-size-xs); }

/* Primary — accent background stays on hover (was broken before
   because the generic .btn:hover was overriding background). */
.btn-primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text);
  filter: brightness(1.08);
}

/* AI button */
.btn-ai {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: var(--color-accent);
}
.btn-ai:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}

/* Danger */
.btn-danger {
  background: var(--color-bg);
  color: var(--color-text);
  border-color: var(--color-border);
}
.btn-danger:hover:not(:disabled) {
  background: var(--color-danger);
  color: var(--color-accent-text);
  border-color: var(--color-danger);
}

/* Ghost (close button, cancel) */
.btn-ghost {
  background: transparent;
  color: var(--color-text-muted);
  border-color: transparent;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: transparent;
  color: var(--color-text);
}
</style>
