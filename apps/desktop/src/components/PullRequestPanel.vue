<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import {
  ghListPrs,
  ghCreatePr,
  ghCheckoutPr,
  ghMergePr,
  ghPrDetail,
  ghPrDiff,
  ghPrChecks,
  gitRemoteInfo,
  type PullRequest,
  type PullRequestDetail,
  type CICheck,
  type RemoteInfo,
  type GitDiff,
  type DiffHunk,
  type DiffLine,
} from "../utils/backend";
import DiffViewer from "./DiffViewer.vue";
import type { DiffMode } from "../utils/diffMode";
import { getPersistedDiffMode } from "../utils/diffMode";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "close"): void;
  (e: "navigate-commit", hash: string): void;
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

// Detail view
const expandedPrNumber = ref<number | null>(null);
const prDetail = ref<PullRequestDetail | null>(null);
const prChecks = ref<CICheck[]>([]);
const prDiffRaw = ref<string>("");
const prDiffFiles = ref<GitDiff[]>([]);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const detailTab = ref<"info" | "diff" | "checks">("info");
const selectedDiffFile = ref<string | null>(null);
const diffMode = ref<DiffMode>(getPersistedDiffMode());

const isGitHub = computed(() => remote.value?.provider === "github");

// ─── Parse unified diff into GitDiff[] ─────────────────

function parseUnifiedDiff(rawDiff: string): GitDiff[] {
  const files: GitDiff[] = [];
  if (!rawDiff.trim()) return files;

  const lines = rawDiff.split("\n");
  let currentFile: GitDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file header: diff --git a/... b/...
    if (line.startsWith("diff --git ")) {
      if (currentFile) files.push(currentFile);
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      const path = match ? match[2] : "unknown";
      currentFile = { path, hunks: [] };
      currentHunk = null;
      continue;
    }

    // Skip diff metadata lines
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("new file ") ||
      line.startsWith("deleted file ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("Binary files ")
    ) {
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (hunkMatch && currentFile) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = parseInt(hunkMatch[2] ?? "1", 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] ?? "1", 10);
      currentHunk = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    // Diff lines
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.substring(1),
          newLineNo: newLine++,
        });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "delete",
          content: line.substring(1),
          oldLineNo: oldLine++,
        });
      } else if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({
          type: "context",
          content: line.startsWith(" ") ? line.substring(1) : line,
          oldLineNo: oldLine++,
          newLineNo: newLine++,
        });
      }
      // Skip "\ No newline at end of file"
    }
  }

  if (currentFile) files.push(currentFile);
  return files;
}

// ─── Data loading ──────────────────────────────────────

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

async function toggleDetail(prNumber: number) {
  if (expandedPrNumber.value === prNumber) {
    expandedPrNumber.value = null;
    prDetail.value = null;
    prChecks.value = [];
    prDiffRaw.value = "";
    prDiffFiles.value = [];
    selectedDiffFile.value = null;
    return;
  }

  expandedPrNumber.value = prNumber;
  detailTab.value = "info";
  detailLoading.value = true;
  detailError.value = null;
  prDetail.value = null;
  prChecks.value = [];
  prDiffRaw.value = "";
  prDiffFiles.value = [];
  selectedDiffFile.value = null;

  try {
    const [detail, checks] = await Promise.all([
      ghPrDetail(props.cwd, prNumber),
      ghPrChecks(props.cwd, prNumber).catch(() => [] as CICheck[]),
    ]);
    prDetail.value = detail;
    prChecks.value = checks;
  } catch (err: any) {
    detailError.value = err.message;
  } finally {
    detailLoading.value = false;
  }
}

async function loadDiff() {
  if (!expandedPrNumber.value || prDiffRaw.value) return;
  detailLoading.value = true;
  try {
    prDiffRaw.value = await ghPrDiff(props.cwd, expandedPrNumber.value);
    prDiffFiles.value = parseUnifiedDiff(prDiffRaw.value);
    if (prDiffFiles.value.length > 0) {
      selectedDiffFile.value = prDiffFiles.value[0].path;
    }
  } catch (err: any) {
    detailError.value = err.message;
  } finally {
    detailLoading.value = false;
  }
}

// Load diff when switching to diff tab
watch(detailTab, (tab) => {
  if (tab === "diff") loadDiff();
});

const selectedDiff = computed<GitDiff | null>(() => {
  if (!selectedDiffFile.value) return null;
  return prDiffFiles.value.find((f) => f.path === selectedDiffFile.value) ?? null;
});

// ─── Actions ───────────────────────────────────────────

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

function mergeableIcon(status: string): string {
  switch (status.toUpperCase()) {
    case "MERGEABLE": return "✅";
    case "CONFLICTING": return "⚠️";
    case "UNKNOWN": return "❓";
    default: return "—";
  }
}

function checkIcon(check: CICheck): string {
  const c = (check.conclusion || check.state || "").toUpperCase();
  if (c === "SUCCESS") return "✅";
  if (c === "FAILURE" || c === "ERROR" || c === "CANCELLED") return "❌";
  if (c === "PENDING" || c === "IN_PROGRESS" || c === "QUEUED") return "⏳";
  if (c === "SKIPPED") return "⏭️";
  return "❓";
}

function checksStatusIcon(status: string): string {
  const s = status.toUpperCase();
  if (s === "SUCCESS" || s === "PASS") return "✅";
  if (s === "FAILURE" || s === "FAIL" || s === "ERROR") return "❌";
  if (s === "PENDING") return "⏳";
  return "—";
}

function renderBody(body: string): string {
  // Simple markdown-ish rendering: preserve newlines, bold, code
  return body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, '<code class="pr-inline-code">$1</code>')
    .replace(/\n/g, "<br />");
}

onMounted(() => {
  loadRemote();
  loadPrs();
});

watch(filterState, loadPrs);
watch(() => props.cwd, () => {
  loadRemote();
  loadPrs();
  expandedPrNumber.value = null;
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
      <div v-for="pr in prs" :key="pr.number" class="pr-item" :class="{ 'pr-item-expanded': expandedPrNumber === pr.number }">
        <div class="pr-item-header">
          <span class="pr-number">#{{ pr.number }}</span>
          <span class="pr-title" @click="toggleDetail(pr.number)">{{ pr.title }}</span>
          <span v-if="pr.draft" class="pr-badge pr-badge-draft">Draft</span>
          <span v-for="label in pr.labels" :key="label" class="pr-badge">{{ label }}</span>
          <button
            class="btn-expand"
            :class="{ 'btn-expand-active': expandedPrNumber === pr.number }"
            @click="toggleDetail(pr.number)"
            :title="expandedPrNumber === pr.number ? 'Collapse' : 'Expand details'"
          >
            ▸
          </button>
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

        <!-- ─── Expanded Detail View ─── -->
        <div v-if="expandedPrNumber === pr.number" class="pr-detail">
          <div v-if="detailLoading && !prDetail" class="pr-detail-loading">
            Loading PR details…
          </div>
          <div v-else-if="detailError && !prDetail" class="pr-error">{{ detailError }}</div>
          <template v-else-if="prDetail">
            <!-- Detail Tabs -->
            <div class="pr-detail-tabs">
              <button
                :class="['pr-detail-tab', { active: detailTab === 'info' }]"
                @click="detailTab = 'info'"
              >
                📋 Info
              </button>
              <button
                :class="['pr-detail-tab', { active: detailTab === 'diff' }]"
                @click="detailTab = 'diff'"
              >
                📝 Diff
                <span v-if="prDetail.changedFiles" class="tab-badge">{{ prDetail.changedFiles }}</span>
              </button>
              <button
                :class="['pr-detail-tab', { active: detailTab === 'checks' }]"
                @click="detailTab = 'checks'"
              >
                {{ checksStatusIcon(prDetail.checksStatus) }} CI
                <span v-if="prChecks.length" class="tab-badge">{{ prChecks.length }}</span>
              </button>
            </div>

            <!-- ─── Info Tab ─── -->
            <div v-if="detailTab === 'info'" class="pr-detail-content">
              <!-- Summary row -->
              <div class="pr-detail-summary">
                <div class="pr-detail-stat">
                  <span class="stat-label">Mergeable</span>
                  <span>{{ mergeableIcon(prDetail.mergeable) }} {{ prDetail.mergeable }}</span>
                </div>
                <div class="pr-detail-stat">
                  <span class="stat-label">Files changed</span>
                  <span>{{ prDetail.changedFiles }}</span>
                </div>
                <div class="pr-detail-stat">
                  <span class="stat-label">Changes</span>
                  <span>
                    <span class="pr-additions">+{{ prDetail.additions }}</span>
                    <span class="pr-deletions"> -{{ prDetail.deletions }}</span>
                  </span>
                </div>
                <div class="pr-detail-stat">
                  <span class="stat-label">Comments</span>
                  <span>{{ prDetail.comments }} + {{ prDetail.reviewComments }} review</span>
                </div>
              </div>

              <!-- Reviewers -->
              <div v-if="prDetail.reviewers.length" class="pr-detail-reviewers">
                <span class="stat-label">Reviewers</span>
                <div class="reviewer-list">
                  <span
                    v-for="reviewer in prDetail.reviewers"
                    :key="reviewer"
                    class="reviewer-badge"
                  >
                    {{ reviewer }}
                  </span>
                </div>
              </div>

              <!-- Body -->
              <div v-if="prDetail.body" class="pr-detail-body">
                <div class="pr-body-content" v-html="renderBody(prDetail.body)" />
              </div>
              <div v-else class="pr-detail-body pr-detail-empty">No description provided.</div>

              <!-- Cross-links -->
              <div class="pr-detail-links">
                <span class="stat-label">Links</span>
                <div class="pr-links-row">
                  <button class="btn btn-xs" @click="openInBrowser(prDetail.url)">
                    🌐 View on GitHub
                  </button>
                  <button class="btn btn-xs" @click="openInBrowser(prDetail.url + '/commits')">
                    📦 Commits
                  </button>
                  <button class="btn btn-xs" @click="openInBrowser(prDetail.url + '/files')">
                    📄 Files changed
                  </button>
                  <button
                    v-if="prDetail.checksStatus"
                    class="btn btn-xs"
                    @click="openInBrowser(prDetail.url + '/checks')"
                  >
                    🔗 CI Runs
                  </button>
                </div>
              </div>

              <!-- Timestamps -->
              <div class="pr-detail-timestamps">
                <span>Created {{ timeAgo(prDetail.createdAt) }}</span>
                <span v-if="prDetail.mergedAt"> · Merged {{ timeAgo(prDetail.mergedAt) }}</span>
                <span v-else> · Updated {{ timeAgo(prDetail.updatedAt) }}</span>
              </div>
            </div>

            <!-- ─── Diff Tab ─── -->
            <div v-if="detailTab === 'diff'" class="pr-detail-content pr-detail-diff">
              <div v-if="detailLoading && !prDiffRaw" class="pr-detail-loading">
                Loading diff…
              </div>
              <template v-else-if="prDiffFiles.length > 0">
                <!-- File list sidebar -->
                <div class="pr-diff-sidebar">
                  <div class="pr-diff-file-count">
                    {{ prDiffFiles.length }} file{{ prDiffFiles.length !== 1 ? "s" : "" }} changed
                  </div>
                  <div
                    v-for="file in prDiffFiles"
                    :key="file.path"
                    :class="['pr-diff-file-entry', { active: selectedDiffFile === file.path }]"
                    @click="selectedDiffFile = file.path"
                  >
                    <span class="pr-diff-file-name">{{ file.path.split('/').pop() }}</span>
                    <span class="pr-diff-file-path">{{ file.path }}</span>
                  </div>
                </div>
                <!-- Diff viewer -->
                <div class="pr-diff-viewer-wrapper">
                  <DiffViewer
                    v-if="selectedDiff"
                    :diff="selectedDiff"
                    :file-path="selectedDiffFile"
                    :diff-mode="diffMode"
                    @update:diff-mode="diffMode = $event"
                  />
                </div>
              </template>
              <div v-else class="pr-detail-empty">No diff available.</div>
            </div>

            <!-- ─── Checks Tab ─── -->
            <div v-if="detailTab === 'checks'" class="pr-detail-content">
              <div v-if="prChecks.length === 0" class="pr-detail-empty">
                No CI checks found for this PR.
              </div>
              <div v-else class="pr-checks-list">
                <div
                  v-for="check in prChecks"
                  :key="check.name"
                  class="pr-check-item"
                >
                  <span class="pr-check-icon">{{ checkIcon(check) }}</span>
                  <span class="pr-check-name">{{ check.name }}</span>
                  <span class="pr-check-state">{{ check.conclusion || check.state }}</span>
                  <button
                    v-if="check.detailsUrl"
                    class="btn btn-xs"
                    @click="openInBrowser(check.detailsUrl)"
                    title="View CI run details"
                  >
                    🔗
                  </button>
                </div>
              </div>
            </div>
          </template>
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
  max-height: 80vh;
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
  transition: border-color 0.15s;
}

.pr-item-expanded {
  border-color: var(--color-accent, #cba6f7);
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

.btn-expand {
  background: none;
  border: none;
  color: var(--text-muted, #6c7086);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  transition: transform 0.15s, color 0.15s;
  line-height: 1;
}

.btn-expand:hover { color: var(--color-accent, #cba6f7); }
.btn-expand-active { transform: rotate(90deg); color: var(--color-accent, #cba6f7); }

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

/* ─── Detail View ─── */
.pr-detail {
  margin-top: 8px;
  border-top: 1px solid var(--border-color, #313244);
  padding-top: 8px;
}

.pr-detail-loading {
  font-size: 12px;
  color: var(--text-muted, #6c7086);
  text-align: center;
  padding: 12px;
}

.pr-detail-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border-color, #313244);
  padding-bottom: 0;
}

.pr-detail-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted, #6c7086);
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: color 0.15s, border-color 0.15s;
}

.pr-detail-tab:hover { color: inherit; }
.pr-detail-tab.active {
  color: var(--color-accent, #cba6f7);
  border-bottom-color: var(--color-accent, #cba6f7);
}

.tab-badge {
  font-size: 10px;
  background: var(--bg-tertiary, #11111b);
  border-radius: 8px;
  padding: 0 5px;
  min-width: 16px;
  text-align: center;
}

.pr-detail-content {
  font-size: 12px;
}

.pr-detail-empty {
  color: var(--text-muted, #6c7086);
  font-style: italic;
  padding: 8px;
}

/* Info tab */
.pr-detail-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.pr-detail-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--bg-tertiary, #11111b);
  border-radius: 4px;
}

.stat-label {
  font-size: 10px;
  color: var(--text-muted, #6c7086);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.pr-detail-reviewers {
  margin-bottom: 10px;
}

.reviewer-list {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.reviewer-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  background: rgba(203, 166, 247, 0.15);
  color: var(--color-accent, #cba6f7);
  border: 1px solid rgba(203, 166, 247, 0.3);
}

.pr-detail-body {
  margin-bottom: 10px;
  padding: 8px;
  background: var(--bg-tertiary, #11111b);
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.pr-body-content {
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.pr-body-content :deep(.pr-inline-code) {
  background: rgba(203, 166, 247, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 11px;
}

.pr-detail-links {
  margin-bottom: 10px;
}

.pr-links-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.pr-detail-timestamps {
  font-size: 11px;
  color: var(--text-muted, #6c7086);
  padding-top: 6px;
  border-top: 1px solid var(--border-color, #313244);
}

/* Diff tab */
.pr-detail-diff {
  display: flex;
  gap: 8px;
  max-height: 400px;
}

.pr-diff-sidebar {
  width: 200px;
  min-width: 160px;
  max-height: 400px;
  overflow-y: auto;
  border-right: 1px solid var(--border-color, #313244);
  padding-right: 8px;
  flex-shrink: 0;
}

.pr-diff-file-count {
  font-size: 11px;
  color: var(--text-muted, #6c7086);
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-color, #313244);
}

.pr-diff-file-entry {
  padding: 4px 6px;
  border-radius: 3px;
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.1s;
}

.pr-diff-file-entry:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.05)); }
.pr-diff-file-entry.active { background: rgba(203, 166, 247, 0.15); }

.pr-diff-file-name {
  display: block;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-diff-file-path {
  display: block;
  font-size: 10px;
  color: var(--text-muted, #6c7086);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-diff-viewer-wrapper {
  flex: 1;
  min-width: 0;
  overflow: auto;
  max-height: 400px;
}

/* Checks tab */
.pr-checks-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pr-check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--bg-tertiary, #11111b);
  border-radius: 4px;
}

.pr-check-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.pr-check-name {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-check-state {
  font-size: 11px;
  color: var(--text-muted, #6c7086);
  text-transform: uppercase;
  letter-spacing: 0.3px;
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
