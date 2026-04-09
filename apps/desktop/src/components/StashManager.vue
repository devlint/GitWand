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
  gap: 8px;
  padding: 12px;
  background: var(--bg-secondary, #1e1e2e);
  border-radius: 8px;
  border: 1px solid var(--border-color, #313244);
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
  font-size: 14px;
  font-weight: 600;
}

.stash-actions {
  display: flex;
  gap: 4px;
}

.stash-error {
  color: var(--color-error, #f38ba8);
  font-size: 12px;
  padding: 4px 8px;
  background: var(--bg-error, rgba(243, 139, 168, 0.1));
  border-radius: 4px;
}

.stash-loading,
.stash-empty {
  font-size: 13px;
  color: var(--text-muted, #6c7086);
  text-align: center;
  padding: 16px 8px;
}

.stash-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stash-item {
  border-radius: 6px;
  border: 1px solid var(--border-color, #313244);
  overflow: hidden;
}

.stash-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition: background 0.15s;
}

.stash-item-header:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.05));
}

.stash-index {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted, #6c7086);
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
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stash-meta {
  font-size: 11px;
  color: var(--text-muted, #6c7086);
  display: flex;
  gap: 8px;
}

.stash-branch {
  color: var(--color-accent, #cba6f7);
}

.stash-item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.stash-diff {
  border-top: 1px solid var(--border-color, #313244);
  padding: 8px;
  background: var(--bg-tertiary, #11111b);
  max-height: 200px;
  overflow: auto;
}

.stash-diff pre {
  margin: 0;
  font-size: 11px;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Button styles (minimal — real app uses shared styles) */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color, #313244);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  transition: all 0.15s;
}

.btn:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.08)); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-sm { font-size: 12px; padding: 3px 8px; }
.btn-xs { font-size: 11px; padding: 2px 6px; }
.btn-primary { background: var(--color-accent, #cba6f7); color: #1e1e2e; border-color: transparent; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-danger:hover { background: var(--color-error, #f38ba8); color: #1e1e2e; }
.btn-ghost { border-color: transparent; }
</style>
