<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import {
  ghListPrs,
  ghCreatePr,
  ghCheckoutPr,
  ghMergePr,
  gitRemoteInfo,
  type PullRequest,
  type RemoteInfo,
} from "../utils/backend";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "close"): void;
}>();

// State
const remote = ref<RemoteInfo | null>(null);
const prs = ref<PullRequest[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);
const filterState = ref<"open" | "closed" | "all">("open");

// Create PR form
const showCreateForm = ref(false);
const newPrTitle = ref("");
const newPrBody = ref("");
const newPrBase = ref("");
const newPrDraft = ref(false);
const isCreating = ref(false);

// Merge dialog
const mergingPr = ref<PullRequest | null>(null);
const mergeMethod = ref<"merge" | "squash" | "rebase">("merge");

const isGitHub = computed(() => remote.value?.provider === "github");

async function loadRemote() {
  try {
    remote.value = await gitRemoteInfo(props.cwd);
  } catch {
    remote.value = null;
  }
}

async function loadPrs() {
  if (!props.cwd) return;
  loading.value = true;
  error.value = null;
  try {
    prs.value = await ghListPrs(props.cwd, filterState.value);
  } catch (err: any) {
    error.value = err.message;
    prs.value = [];
  } finally {
    loading.value = false;
  }
}

async function createPr() {
  if (!props.cwd || !newPrTitle.value.trim()) return;
  isCreating.value = true;
  error.value = null;
  try {
    const pr = await ghCreatePr(
      props.cwd,
      newPrTitle.value.trim(),
      newPrBody.value.trim(),
      newPrBase.value.trim(),
      newPrDraft.value,
    );
    success.value = `PR #${pr.number} created: ${pr.url}`;
    showCreateForm.value = false;
    newPrTitle.value = "";
    newPrBody.value = "";
    newPrDraft.value = false;
    await loadPrs();
  } catch (err: any) {
    error.value = err.message;
  } finally {
    isCreating.value = false;
  }
}

async function checkoutPr(pr: PullRequest) {
  try {
    await ghCheckoutPr(props.cwd, pr.number);
    success.value = `Checked out PR #${pr.number} (${pr.branch})`;
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  }
}

async function mergePr() {
  if (!mergingPr.value) return;
  try {
    await ghMergePr(props.cwd, mergingPr.value.number, mergeMethod.value);
    success.value = `PR #${mergingPr.value.number} merged!`;
    mergingPr.value = null;
    await loadPrs();
    emit("refresh");
  } catch (err: any) {
    error.value = err.message;
  }
}

function openInBrowser(url: string) {
  window.open(url, "_blank");
}

function timeAgo(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return dateStr;
  }
}

onMounted(() => {
  loadRemote();
  loadPrs();
});

watch(filterState, loadPrs);
watch(() => props.cwd, () => {
  loadRemote();
  loadPrs();
});
</script>

<template>
  <div class="pr-panel">
    <div class="pr-header">
      <h3>🔀 Pull Requests</h3>
      <div class="pr-header-actions">
        <select v-model="filterState" class="pr-filter">
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <button class="btn btn-sm btn-primary" @click="showCreateForm = !showCreateForm">
          + New PR
        </button>
        <button class="btn btn-sm btn-ghost" @click="loadPrs" title="Refresh">↻</button>
        <button class="btn btn-sm btn-ghost" @click="$emit('close')">✕</button>
      </div>
    </div>

    <div v-if="error" class="pr-error">{{ error }}</div>
    <div v-if="success" class="pr-success" @click="success = null">{{ success }}</div>

    <!-- Create PR Form -->
    <div v-if="showCreateForm" class="pr-create-form">
      <input
        v-model="newPrTitle"
        class="pr-input"
        type="text"
        placeholder="PR title…"
        @keydown.enter="createPr"
      />
      <textarea
        v-model="newPrBody"
        class="pr-textarea"
        placeholder="Description (optional)…"
        rows="3"
      />
      <div class="pr-create-options">
        <input
          v-model="newPrBase"
          class="pr-input pr-input-sm"
          type="text"
          placeholder="Base branch (default: main)"
        />
        <label class="pr-draft-label">
          <input type="checkbox" v-model="newPrDraft" />
          Draft
        </label>
        <button
          class="btn btn-sm btn-primary"
          :disabled="!newPrTitle.trim() || isCreating"
          @click="createPr"
        >
          {{ isCreating ? "Creating…" : "Create PR" }}
        </button>
      </div>
    </div>

    <!-- Merge dialog -->
    <div v-if="mergingPr" class="pr-merge-dialog">
      <p>Merge PR #{{ mergingPr.number }}: <strong>{{ mergingPr.title }}</strong></p>
      <div class="pr-merge-options">
        <label><input type="radio" v-model="mergeMethod" value="merge" /> Merge commit</label>
        <label><input type="radio" v-model="mergeMethod" value="squash" /> Squash and merge</label>
        <label><input type="radio" v-model="mergeMethod" value="rebase" /> Rebase and merge</label>
      </div>
      <div class="pr-merge-actions">
        <button class="btn btn-primary" @click="mergePr">Merge</button>
        <button class="btn" @click="mergingPr = null">Cancel</button>
      </div>
    </div>

    <!-- PR List -->
    <div v-if="loading" class="pr-loading">Loading pull requests…</div>

    <div v-else-if="prs.length === 0" class="pr-empty">
      No {{ filterState === "all" ? "" : filterState }} pull requests found.
    </div>

    <div v-else class="pr-list">
      <div v-for="pr in prs" :key="pr.number" class="pr-item">
        <div class="pr-item-header">
          <span class="pr-number">#{{ pr.number }}</span>
          <span class="pr-title" @click="openInBrowser(pr.url)">{{ pr.title }}</span>
          <span v-if="pr.draft" class="pr-badge pr-badge-draft">Draft</span>
          <span v-for="label in pr.labels" :key="label" class="pr-badge">{{ label }}</span>
        </div>
        <div class="pr-item-meta">
          <span>{{ pr.author }}</span>
          <span class="pr-branch-info">{{ pr.branch }} → {{ pr.base }}</span>
          <span class="pr-stats">
            <span class="pr-additions">+{{ pr.additions }}</span>
            <span class="pr-deletions">-{{ pr.deletions }}</span>
          </span>
          <span class="pr-time">{{ timeAgo(pr.updatedAt || pr.createdAt) }}</span>
        </div>
        <div class="pr-item-actions">
          <button class="btn btn-xs" @click="checkoutPr(pr)" title="Checkout this PR locally">
            Checkout
          </button>
          <button
            v-if="pr.state === 'OPEN' || pr.state === 'open'"
            class="btn btn-xs btn-primary"
            @click="mergingPr = pr"
            title="Merge this PR"
          >
            Merge
          </button>
          <button class="btn btn-xs" @click="openInBrowser(pr.url)" title="Open in browser">
            ↗
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pr-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg-secondary, #1e1e2e);
  border-radius: 8px;
  border: 1px solid var(--border-color, #313244);
  max-height: 500px;
  overflow-y: auto;
}

.pr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pr-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.pr-header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.pr-filter {
  background: var(--bg-tertiary, #11111b);
  border: 1px solid var(--border-color, #313244);
  border-radius: 4px;
  color: inherit;
  font-size: 11px;
  padding: 2px 6px;
}

.pr-error {
  color: var(--color-error, #f38ba8);
  font-size: 12px;
  padding: 6px 8px;
  background: rgba(243, 139, 168, 0.1);
  border-radius: 4px;
}

.pr-success {
  color: var(--color-success, #a6e3a1);
  font-size: 12px;
  padding: 6px 8px;
  background: rgba(166, 227, 161, 0.1);
  border-radius: 4px;
  cursor: pointer;
}

.pr-loading, .pr-empty {
  font-size: 13px;
  color: var(--text-muted, #6c7086);
  text-align: center;
  padding: 16px;
}

/* Create form */
.pr-create-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--bg-tertiary, #11111b);
  border-radius: 6px;
  border: 1px solid var(--border-color, #313244);
}

.pr-input {
  background: var(--bg-secondary, #1e1e2e);
  border: 1px solid var(--border-color, #313244);
  border-radius: 4px;
  padding: 6px 8px;
  color: inherit;
  font-size: 13px;
  outline: none;
}

.pr-input:focus { border-color: var(--color-accent, #cba6f7); }
.pr-input-sm { font-size: 12px; padding: 4px 6px; flex: 1; }

.pr-textarea {
  background: var(--bg-secondary, #1e1e2e);
  border: 1px solid var(--border-color, #313244);
  border-radius: 4px;
  padding: 6px 8px;
  color: inherit;
  font-size: 12px;
  resize: vertical;
  outline: none;
  font-family: inherit;
}

.pr-textarea:focus { border-color: var(--color-accent, #cba6f7); }

.pr-create-options {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pr-draft-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  white-space: nowrap;
}

/* Merge dialog */
.pr-merge-dialog {
  padding: 10px;
  background: var(--bg-tertiary, #11111b);
  border-radius: 6px;
  border: 1px solid var(--border-color, #313244);
}

.pr-merge-dialog p { margin: 0 0 8px; font-size: 13px; }

.pr-merge-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.pr-merge-options label {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pr-merge-actions {
  display: flex;
  gap: 6px;
}

/* PR list */
.pr-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pr-item {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #313244);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pr-item-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.pr-number {
  font-weight: 700;
  color: var(--color-accent, #cba6f7);
  font-size: 12px;
}

.pr-title {
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-title:hover { text-decoration: underline; }

.pr-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-tertiary, #11111b);
  border: 1px solid var(--border-color, #313244);
}

.pr-badge-draft {
  color: var(--text-muted, #6c7086);
  border-color: var(--text-muted, #6c7086);
}

.pr-item-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-muted, #6c7086);
}

.pr-branch-info {
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 10px;
}

.pr-stats {
  display: flex;
  gap: 4px;
}

.pr-additions { color: var(--color-success, #a6e3a1); }
.pr-deletions { color: var(--color-error, #f38ba8); }

.pr-item-actions {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

/* Button styles */
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
.btn-ghost { border-color: transparent; }
</style>
