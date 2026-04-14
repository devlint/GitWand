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
const stashMessage = ref("");

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

async function createStash() {
  if (!props.cwd) return;
  try {
    await gitStash(props.cwd);
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
        <button class="btn btn-sm btn-primary" @click="createStash" title="Stash all changes">
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
.stash-manager {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  max-height: 400px;
  overflow-y: auto;
}

.stash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.stash-header h3 {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.stash-actions {
  display: flex;
  gap: var(--space-1);
}

.stash-error {
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
  background: var(--color-danger-soft);
  border-radius: var(--radius-sm);
}

.stash-loading,
.stash-empty {
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  text-align: center;
  padding: var(--space-4) var(--space-2);
}

.stash-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.stash-item {
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  overflow: hidden;
}

.stash-item-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2);
  cursor: pointer;
  transition: background var(--transition-base);
}

.stash-item-header:hover {
  background: var(--color-bg-hover);
}

.stash-index {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--color-text-muted);
  min-width: 20px;
  text-align: center;
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stash-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  display: flex;
  gap: var(--space-2);
}

.stash-branch {
  color: var(--color-accent);
}

.stash-item-actions {
  display: flex;
  gap: var(--space-1);
  flex-shrink: 0;
}

.stash-diff {
  border-top: 1px solid var(--color-border);
  padding: var(--space-2);
  background: var(--color-bg);
  max-height: 200px;
  overflow: auto;
}

.stash-diff pre {
  margin: 0;
  font-size: var(--font-size-xs);
  font-family: "JetBrains Mono", "Fira Code", monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Button styles (minimal — real app uses shared styles) */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
  transition: all var(--transition-base);
}

.btn:hover { background: var(--color-bg-hover); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-sm { font-size: var(--font-size-xs); padding: var(--space-1) var(--space-2); }
.btn-xs { font-size: var(--font-size-xs); padding: 2px 6px; }
.btn-primary { background: var(--color-accent); color: var(--color-accent-text); border-color: transparent; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-danger:hover { background: var(--color-danger); color: var(--color-accent-text); }
.btn-ghost { border-color: transparent; }
</style>
