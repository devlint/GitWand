<script setup lang="ts">
import { ref, computed } from "vue";
import {
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  getGitLog,
  getGitBranches,
  type GitLogEntry,
  type GitBranch,
} from "../utils/backend";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "close"): void;
}>();

const branches = ref<GitBranch[]>([]);
const selectedBranch = ref<string>("");
const commits = ref<GitLogEntry[]>([]);
const selectedHashes = ref<Set<string>>(new Set());
const loading = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);
const isCherryPicking = ref(false);
const hasConflicts = ref(false);

const canPick = computed(() => selectedHashes.value.size > 0 && !isCherryPicking.value);

async function loadBranches() {
  if (!props.cwd) return;
  try {
    branches.value = await getGitBranches(props.cwd);
  } catch (err: any) {
    error.value = err.message;
  }
}

async function loadCommits() {
  if (!props.cwd || !selectedBranch.value) return;
  loading.value = true;
  selectedHashes.value = new Set();
  try {
    // Get commits from the selected branch (top 30)
    // We use git log with the branch name to get its commits
    commits.value = await getGitLog(props.cwd, 30);
    // Filter: we re-fetch with branch context — for now show all recent
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function toggleCommit(hash: string) {
  const s = new Set(selectedHashes.value);
  if (s.has(hash)) {
    s.delete(hash);
  } else {
    s.add(hash);
  }
  selectedHashes.value = s;
}

async function doCherryPick() {
  if (!props.cwd || selectedHashes.value.size === 0) return;
  isCherryPicking.value = true;
  error.value = null;
  success.value = null;
  try {
    const result = await gitCherryPick(props.cwd, Array.from(selectedHashes.value));
    if (result.conflicts) {
      hasConflicts.value = true;
      error.value = "Cherry-pick has conflicts. Resolve them, then click Continue.";
    } else if (result.success) {
      success.value = `Cherry-picked ${selectedHashes.value.size} commit(s) successfully.`;
      selectedHashes.value = new Set();
      hasConflicts.value = false;
    } else {
      error.value = result.message;
    }
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  } finally {
    isCherryPicking.value = false;
  }
}

async function abortPick() {
  try {
    await gitCherryPickAbort(props.cwd);
    hasConflicts.value = false;
    error.value = null;
    success.value = "Cherry-pick aborted.";
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  }
}

async function continuePick() {
  isCherryPicking.value = true;
  try {
    const result = await gitCherryPickContinue(props.cwd);
    if (result.success) {
      hasConflicts.value = false;
      success.value = "Cherry-pick completed.";
    } else {
      error.value = result.message;
    }
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  } finally {
    isCherryPicking.value = false;
  }
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

// Init
loadBranches();
</script>

<template>
  <div class="cherry-pick-panel">
    <div class="cp-header">
      <h3>🍒 Cherry-pick</h3>
      <button class="btn btn-sm btn-ghost" @click="$emit('close')">✕</button>
    </div>

    <div v-if="error" class="cp-error">{{ error }}</div>
    <div v-if="success" class="cp-success">{{ success }}</div>

    <!-- Conflict resolution controls -->
    <div v-if="hasConflicts" class="cp-conflict-actions">
      <button class="btn btn-primary" @click="continuePick">Continue</button>
      <button class="btn btn-danger" @click="abortPick">Abort</button>
    </div>

    <!-- Branch selector -->
    <div v-if="!hasConflicts" class="cp-branch-select">
      <label>Source branch:</label>
      <select v-model="selectedBranch" @change="loadCommits">
        <option value="" disabled>Select a branch…</option>
        <option
          v-for="branch in branches.filter(b => !b.isCurrent)"
          :key="branch.name"
          :value="branch.name"
        >
          {{ branch.name }}
        </option>
      </select>
    </div>

    <!-- Commit list -->
    <div v-if="selectedBranch && !hasConflicts" class="cp-commits">
      <div v-if="loading" class="cp-loading">Loading commits…</div>
      <div
        v-for="commit in commits"
        :key="commit.hashFull"
        class="cp-commit"
        :class="{ selected: selectedHashes.has(commit.hashFull) }"
        @click="toggleCommit(commit.hashFull)"
      >
        <span class="cp-check">{{ selectedHashes.has(commit.hashFull) ? '☑' : '☐' }}</span>
        <span class="cp-hash">{{ commit.hash }}</span>
        <span class="cp-msg">{{ commit.message }}</span>
        <span class="cp-date">{{ formatDate(commit.date) }}</span>
      </div>
    </div>

    <!-- Pick button -->
    <div v-if="!hasConflicts && selectedHashes.size > 0" class="cp-footer">
      <button class="btn btn-primary" :disabled="!canPick" @click="doCherryPick">
        Cherry-pick {{ selectedHashes.size }} commit{{ selectedHashes.size > 1 ? 's' : '' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.cherry-pick-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  max-height: 450px;
}

.cp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cp-header h3 {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.cp-error {
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
  background: var(--color-danger-soft);
  border-radius: var(--radius-sm);
}

.cp-success {
  color: var(--color-success);
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
  background: var(--color-success-soft);
  border-radius: var(--radius-sm);
}

.cp-conflict-actions {
  display: flex;
  gap: var(--space-2);
}

.cp-branch-select {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cp-branch-select label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.cp-branch-select select {
  flex: 1;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: inherit;
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-xs);
}

.cp-commits {
  overflow-y: auto;
  max-height: 280px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cp-loading {
  text-align: center;
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  padding: var(--space-3);
}

.cp-commit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--font-size-xs);
  transition: background var(--transition-base);
}

.cp-commit:hover {
  background: var(--color-bg-hover);
}

.cp-commit.selected {
  background: var(--color-accent-soft);
}

.cp-check {
  flex-shrink: 0;
  font-size: 14px;
}

.cp-hash {
  font-family: "JetBrains Mono", "Fira Code", monospace;
  color: var(--color-accent);
  flex-shrink: 0;
}

.cp-msg {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cp-date {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

.cp-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-1);
}

/* Button styles */
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
  padding: var(--space-1) var(--space-3);
  transition: all var(--transition-base);
}

.btn:hover { background: var(--color-bg-hover); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-sm { font-size: var(--font-size-xs); padding: var(--space-1) var(--space-2); }
.btn-primary { background: var(--color-accent); color: var(--color-accent-text); border-color: transparent; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-danger { background: var(--color-danger); color: var(--color-accent-text); border-color: transparent; }
.btn-ghost { border-color: transparent; }
</style>
