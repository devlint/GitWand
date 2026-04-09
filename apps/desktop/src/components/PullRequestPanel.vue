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
  show: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "refresh"): void;
  (e: "navigate-commit", hash: string): void;
}>();

// ─── State ─────────────────────────────────────────────
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

// Detail panel (right column)
const selectedPr = ref<PullRequest | null>(null);
const prDetail = ref<PullRequestDetail | null>(null);
const prChecks = ref<CICheck[]>([]);
const prDiffFiles = ref<GitDiff[]>([]);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const detailTab = ref<"info" | "diff" | "checks">("info");
const selectedDiffFile = ref<string | null>(null);
const diffMode = ref<DiffMode>(getPersistedDiffMode());

const isGitHub = computed(() => remote.value?.provider === "github");
const hasDetail = computed(() => !!selectedPr.value);

// ─── Parse unified diff ─────────────────────────────────
function parseUnifiedDiff(rawDiff: string): GitDiff[] {
  const files: GitDiff[] = [];
  if (!rawDiff.trim()) return files;
  const lines = rawDiff.split("\n");
  let currentFile: GitDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0, newLine = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentFile) files.push(currentFile);
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      currentFile = { path: match ? match[2] : "unknown", hunks: [] };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
        line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("new file ") ||
        line.startsWith("deleted file ") || line.startsWith("similarity index ") ||
        line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("Binary files ")) continue;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (hunkMatch && currentFile) {
      currentHunk = {
        header: line,
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      continue;
    }
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.substring(1), newLineNo: newLine++ });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "delete", content: line.substring(1), oldLineNo: oldLine++ });
      } else if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({ type: "context", content: line.startsWith(" ") ? line.substring(1) : line, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }
  }
  if (currentFile) files.push(currentFile);
  return files;
}

// ─── Data loading ───────────────────────────────────────
async function loadRemote() {
  try { remote.value = await gitRemoteInfo(props.cwd); }
  catch { remote.value = null; }
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

async function selectPr(pr: PullRequest) {
  if (selectedPr.value?.number === pr.number) return;
  selectedPr.value = pr;
  prDetail.value = null;
  prChecks.value = [];
  prDiffFiles.value = [];
  selectedDiffFile.value = null;
  detailTab.value = "info";
  detailLoading.value = true;
  detailError.value = null;
  try {
    const [detail, checks] = await Promise.all([
      ghPrDetail(props.cwd, pr.number),
      ghPrChecks(props.cwd, pr.number).catch(() => [] as CICheck[]),
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
  if (!selectedPr.value || prDiffFiles.value.length) return;
  detailLoading.value = true;
  try {
    const raw = await ghPrDiff(props.cwd, selectedPr.value.number);
    prDiffFiles.value = parseUnifiedDiff(raw);
    if (prDiffFiles.value.length) selectedDiffFile.value = prDiffFiles.value[0].path;
  } catch (err: any) {
    detailError.value = err.message;
  } finally {
    detailLoading.value = false;
  }
}

watch(detailTab, (tab) => { if (tab === "diff") loadDiff(); });

const selectedDiff = computed<GitDiff | null>(() =>
  selectedDiffFile.value ? (prDiffFiles.value.find((f) => f.path === selectedDiffFile.value) ?? null) : null
);

// ─── Actions ────────────────────────────────────────────
async function createPr() {
  if (!props.cwd || !newPrTitle.value.trim()) return;
  isCreating.value = true;
  error.value = null;
  try {
    const pr = await ghCreatePr(props.cwd, newPrTitle.value.trim(), newPrBody.value.trim(), newPrBase.value.trim(), newPrDraft.value);
    success.value = `PR #${pr.number} créée`;
    showCreateForm.value = false;
    newPrTitle.value = ""; newPrBody.value = ""; newPrDraft.value = false;
    await loadPrs();
  } catch (err: any) { error.value = err.message; }
  finally { isCreating.value = false; }
}

async function checkoutPr(pr: PullRequest) {
  try {
    await ghCheckoutPr(props.cwd, pr.number);
    success.value = `Checkout PR #${pr.number}`;
    emit("refresh");
  } catch (err: any) { error.value = err.message; }
}

async function mergePr() {
  if (!mergingPr.value) return;
  try {
    await ghMergePr(props.cwd, mergingPr.value.number, mergeMethod.value);
    success.value = `PR #${mergingPr.value.number} mergée !`;
    mergingPr.value = null;
    await loadPrs();
    emit("refresh");
  } catch (err: any) { error.value = err.message; }
}

function openInBrowser(url: string) { window.open(url, "_blank"); }

function timeAgo(dateStr: string): string {
  try {
    const d = new Date(dateStr), now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}j`;
  } catch { return dateStr; }
}

function mergeableIcon(s: string) {
  switch (s.toUpperCase()) {
    case "MERGEABLE": return "✅";
    case "CONFLICTING": return "⚠️";
    default: return "—";
  }
}

function checkIcon(c: CICheck): string {
  const s = (c.conclusion || c.state || "").toUpperCase();
  if (s === "SUCCESS") return "✅";
  if (["FAILURE","ERROR","CANCELLED"].includes(s)) return "❌";
  if (["PENDING","IN_PROGRESS","QUEUED"].includes(s)) return "⏳";
  if (s === "SKIPPED") return "⏭️";
  return "❓";
}

function checksIcon(status: string): string {
  const s = status.toUpperCase();
  if (s === "SUCCESS" || s === "PASS") return "✅";
  if (["FAILURE","FAIL","ERROR"].includes(s)) return "❌";
  if (s === "PENDING") return "⏳";
  return "";
}

function renderBody(body: string): string {
  return body
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, '<code class="pr-code">$1</code>')
    .replace(/\n/g, "<br />");
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => {
  loadRemote();
  loadPrs();
});

watch(() => props.show, (v) => { if (v) { loadRemote(); loadPrs(); } });
watch(filterState, loadPrs);
watch(() => props.cwd, () => { loadRemote(); loadPrs(); selectedPr.value = null; });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="pr-backdrop"
      @click.self="emit('close')"
      @keydown="handleKeydown"
    >
      <div class="pr-overlay" role="dialog" aria-modal="true" aria-label="Pull Requests">
        <!-- Header -->
        <div class="pr-overlay-header">
          <span class="pr-overlay-title">🔀 Pull Requests</span>
          <div class="pr-overlay-actions">
            <select v-model="filterState" class="pr-filter">
              <option value="open">Ouvertes</option>
              <option value="closed">Fermées</option>
              <option value="all">Toutes</option>
            </select>
            <button class="eco-btn eco-btn--primary" @click="showCreateForm = !showCreateForm">
              + Nouvelle PR
            </button>
            <button class="eco-btn" @click="loadPrs" title="Rafraîchir">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5M13.5 2.5v3h-3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="eco-btn eco-close" @click="emit('close')" title="Fermer">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div v-if="error" class="pr-msg pr-msg--error">{{ error }}</div>
        <div v-if="success" class="pr-msg pr-msg--success" @click="success = null">{{ success }}</div>

        <!-- Create form -->
        <div v-if="showCreateForm" class="pr-create-form">
          <input v-model="newPrTitle" class="eco-input" type="text" placeholder="Titre de la PR…" @keydown.enter="createPr" />
          <textarea v-model="newPrBody" class="eco-input eco-textarea" placeholder="Description (optionnelle)…" rows="2" />
          <div class="pr-create-row">
            <input v-model="newPrBase" class="eco-input eco-input--sm" type="text" placeholder="Branche cible (défaut : main)" />
            <label class="pr-draft-label">
              <input type="checkbox" v-model="newPrDraft" /> Draft
            </label>
            <button class="eco-btn eco-btn--primary" :disabled="!newPrTitle.trim() || isCreating" @click="createPr">
              {{ isCreating ? "Création…" : "Créer" }}
            </button>
          </div>
        </div>

        <!-- Merge dialog -->
        <div v-if="mergingPr" class="pr-merge-dialog">
          <p>Merger la PR #{{ mergingPr.number }} : <strong>{{ mergingPr.title }}</strong></p>
          <div class="pr-merge-options">
            <label><input type="radio" v-model="mergeMethod" value="merge" /> Merge commit</label>
            <label><input type="radio" v-model="mergeMethod" value="squash" /> Squash and merge</label>
            <label><input type="radio" v-model="mergeMethod" value="rebase" /> Rebase and merge</label>
          </div>
          <div class="pr-merge-actions">
            <button class="eco-btn eco-btn--primary" @click="mergePr">Merger</button>
            <button class="eco-btn" @click="mergingPr = null">Annuler</button>
          </div>
        </div>

        <!-- Body: two columns -->
        <div class="pr-body">
          <!-- Left: PR list -->
          <div class="pr-list-col">
            <div v-if="loading" class="pr-placeholder">Chargement…</div>
            <div v-else-if="prs.length === 0" class="pr-placeholder">Aucune PR {{ filterState !== 'all' ? filterState === 'open' ? 'ouverte' : 'fermée' : '' }} trouvée.</div>
            <div v-else class="pr-list">
              <button
                v-for="pr in prs"
                :key="pr.number"
                :class="['pr-item', { 'pr-item--active': selectedPr?.number === pr.number }]"
                @click="selectPr(pr)"
              >
                <div class="pr-item-top">
                  <span class="pr-num">#{{ pr.number }}</span>
                  <span v-if="pr.draft" class="pr-chip pr-chip--draft">Draft</span>
                  <span class="pr-time">{{ timeAgo(pr.updatedAt || pr.createdAt) }}</span>
                </div>
                <div class="pr-item-title">{{ pr.title }}</div>
                <div class="pr-item-meta">
                  <span class="pr-author">{{ pr.author }}</span>
                  <span class="pr-branch mono">{{ pr.branch }} → {{ pr.base }}</span>
                  <span class="pr-stats">
                    <span class="add">+{{ pr.additions }}</span>
                    <span class="del"> -{{ pr.deletions }}</span>
                  </span>
                </div>
                <div class="pr-item-chips">
                  <span v-for="label in pr.labels" :key="label" class="pr-chip">{{ label }}</span>
                </div>
                <div class="pr-item-actions" @click.stop>
                  <button class="eco-btn eco-btn--xs" @click="checkoutPr(pr)">Checkout</button>
                  <button v-if="pr.state === 'OPEN' || pr.state === 'open'" class="eco-btn eco-btn--xs eco-btn--primary" @click="mergingPr = pr">Merger</button>
                  <button class="eco-btn eco-btn--xs" @click="openInBrowser(pr.url)" title="Ouvrir sur GitHub">↗</button>
                </div>
              </button>
            </div>
          </div>

          <!-- Right: Detail panel -->
          <div class="pr-detail-col">
            <div v-if="!selectedPr" class="pr-placeholder pr-placeholder--detail">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
                <path d="M6 9v6M18 15V9a3 3 0 0 0-3-3H9"/>
              </svg>
              <span>Sélectionnez une PR</span>
            </div>
            <div v-else-if="detailLoading && !prDetail" class="pr-placeholder">Chargement des détails…</div>
            <div v-else-if="detailError && !prDetail" class="pr-msg pr-msg--error">{{ detailError }}</div>
            <template v-else-if="prDetail">
              <!-- Detail header -->
              <div class="pr-detail-header">
                <div class="pr-detail-title">
                  <span class="pr-num">#{{ prDetail.number }}</span>
                  <span>{{ prDetail.title }}</span>
                </div>
                <div class="pr-detail-subtitle">
                  <span>{{ prDetail.author }}</span>
                  <span class="mono">{{ prDetail.branch }} → {{ prDetail.base }}</span>
                  <span>{{ timeAgo(prDetail.createdAt) }}</span>
                  <span v-if="prDetail.mergedAt">· Mergée {{ timeAgo(prDetail.mergedAt) }}</span>
                </div>
              </div>

              <!-- Detail tabs -->
              <div class="pr-detail-tabs">
                <button :class="['pr-tab', { active: detailTab === 'info' }]" @click="detailTab = 'info'">Info</button>
                <button :class="['pr-tab', { active: detailTab === 'diff' }]" @click="detailTab = 'diff'">
                  Diff <span v-if="prDetail.changedFiles" class="pr-tab-count">{{ prDetail.changedFiles }}</span>
                </button>
                <button :class="['pr-tab', { active: detailTab === 'checks' }]" @click="detailTab = 'checks'">
                  {{ checksIcon(prDetail.checksStatus) }} CI
                  <span v-if="prChecks.length" class="pr-tab-count">{{ prChecks.length }}</span>
                </button>
                <div class="pr-tab-spacer" />
                <button class="eco-btn eco-btn--xs" @click="openInBrowser(prDetail.url)">↗ GitHub</button>
              </div>

              <!-- Info tab -->
              <div v-if="detailTab === 'info'" class="pr-detail-body">
                <div class="pr-stats-grid">
                  <div class="pr-stat">
                    <span class="pr-stat-label">Merge</span>
                    <span>{{ mergeableIcon(prDetail.mergeable) }} {{ prDetail.mergeable }}</span>
                  </div>
                  <div class="pr-stat">
                    <span class="pr-stat-label">Fichiers</span>
                    <span>{{ prDetail.changedFiles }}</span>
                  </div>
                  <div class="pr-stat">
                    <span class="pr-stat-label">Diff</span>
                    <span><span class="add">+{{ prDetail.additions }}</span><span class="del"> -{{ prDetail.deletions }}</span></span>
                  </div>
                  <div class="pr-stat">
                    <span class="pr-stat-label">Commentaires</span>
                    <span>{{ prDetail.comments + prDetail.reviewComments }}</span>
                  </div>
                </div>

                <div v-if="prDetail.reviewers.length" class="pr-reviewers">
                  <span class="pr-section-label">Reviewers</span>
                  <div class="pr-reviewer-list">
                    <span v-for="r in prDetail.reviewers" :key="r" class="pr-chip">{{ r }}</span>
                  </div>
                </div>

                <div v-if="prDetail.labels.length" class="pr-labels">
                  <span class="pr-section-label">Labels</span>
                  <div class="pr-label-list">
                    <span v-for="l in prDetail.labels" :key="l" class="pr-chip">{{ l }}</span>
                  </div>
                </div>

                <div class="pr-section-label">Description</div>
                <div v-if="prDetail.body" class="pr-body-text" v-html="renderBody(prDetail.body)" />
                <div v-else class="pr-placeholder pr-placeholder--sm">Aucune description.</div>

                <div class="pr-links">
                  <button class="eco-btn eco-btn--xs" @click="openInBrowser(prDetail.url + '/commits')">📦 Commits</button>
                  <button class="eco-btn eco-btn--xs" @click="openInBrowser(prDetail.url + '/files')">📄 Fichiers</button>
                  <button v-if="prDetail.checksStatus" class="eco-btn eco-btn--xs" @click="openInBrowser(prDetail.url + '/checks')">🔗 CI</button>
                </div>
              </div>

              <!-- Diff tab -->
              <div v-if="detailTab === 'diff'" class="pr-detail-body pr-diff-body">
                <div v-if="detailLoading && !prDiffFiles.length" class="pr-placeholder">Chargement du diff…</div>
                <template v-else-if="prDiffFiles.length">
                  <div class="pr-diff-sidebar">
                    <div class="pr-diff-file-count">{{ prDiffFiles.length }} fichier{{ prDiffFiles.length > 1 ? 's' : '' }}</div>
                    <button
                      v-for="file in prDiffFiles"
                      :key="file.path"
                      :class="['pr-diff-file', { active: selectedDiffFile === file.path }]"
                      @click="selectedDiffFile = file.path"
                    >
                      <span class="pr-diff-file-name">{{ file.path.split('/').pop() }}</span>
                      <span class="pr-diff-file-path">{{ file.path }}</span>
                    </button>
                  </div>
                  <div class="pr-diff-viewer">
                    <DiffViewer v-if="selectedDiff" :diff="selectedDiff" :file-path="selectedDiffFile" :diff-mode="diffMode" @update:diff-mode="diffMode = $event" />
                  </div>
                </template>
                <div v-else class="pr-placeholder">Aucun diff disponible.</div>
              </div>

              <!-- CI tab -->
              <div v-if="detailTab === 'checks'" class="pr-detail-body">
                <div v-if="prChecks.length === 0" class="pr-placeholder">Aucun check CI trouvé.</div>
                <div v-else class="pr-checks">
                  <div v-for="c in prChecks" :key="c.name" class="pr-check">
                    <span class="pr-check-icon">{{ checkIcon(c) }}</span>
                    <span class="pr-check-name">{{ c.name }}</span>
                    <span class="pr-check-state">{{ c.conclusion || c.state }}</span>
                    <button v-if="c.detailsUrl" class="eco-btn eco-btn--xs" @click="openInBrowser(c.detailsUrl)">↗</button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ─── Backdrop + overlay ──────────────────────────────── */
.pr-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: pr-fade 0.12s ease-out;
}

@keyframes pr-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.pr-overlay {
  width: 92vw;
  max-width: 1200px;
  height: 85vh;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: pr-slide 0.15s ease-out;
}

@keyframes pr-slide {
  from { opacity: 0; transform: translateY(-8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ─── Header ──────────────────────────────────────────── */
.pr-overlay-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.pr-overlay-title {
  font-size: 13px;
  font-weight: 600;
  flex: 1;
}

.pr-overlay-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pr-filter {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
}

/* ─── Messages ────────────────────────────────────────── */
.pr-msg {
  font-size: 12px;
  padding: 6px 16px;
  flex-shrink: 0;
}
.pr-msg--error { color: var(--color-error, #f38ba8); background: rgba(243,139,168,0.1); }
.pr-msg--success { color: var(--color-success, #a6e3a1); background: rgba(166,227,161,0.1); cursor: pointer; }

/* ─── Create form ─────────────────────────────────────── */
.pr-create-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.pr-create-row {
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
  color: var(--color-text-muted);
}

/* ─── Merge dialog ────────────────────────────────────── */
.pr-merge-dialog {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  background: var(--color-bg-tertiary);
}
.pr-merge-dialog p { margin: 0 0 8px; font-size: 13px; }
.pr-merge-options { display: flex; gap: 16px; margin-bottom: 10px; }
.pr-merge-options label { font-size: 12px; display: flex; align-items: center; gap: 5px; cursor: pointer; }
.pr-merge-actions { display: flex; gap: 6px; }

/* ─── Body: two columns ───────────────────────────────── */
.pr-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Left column: PR list */
.pr-list-col {
  width: 320px;
  min-width: 260px;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex-shrink: 0;
}

.pr-list {
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 2px;
}

.pr-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.pr-placeholder--detail { opacity: 0.6; }
.pr-placeholder--sm { padding: 8px; font-size: 12px; color: var(--color-text-muted); font-style: italic; }

.pr-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  background: transparent;
  color: var(--color-text);
  transition: background 0.1s, border-color 0.1s;
  width: 100%;
}

.pr-item:hover { background: var(--color-bg-tertiary); }
.pr-item--active {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent);
}

.pr-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pr-num {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-accent);
}

.pr-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-muted);
}

.pr-item-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.pr-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.pr-branch {
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.pr-stats { display: flex; gap: 3px; }
.add { color: var(--color-success, #a6e3a1); }
.del { color: var(--color-error, #f38ba8); }

.pr-item-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.pr-item-actions {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.pr-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.pr-chip--draft {
  color: var(--color-text-muted);
  border-color: var(--color-text-muted);
}

/* Right column: Detail */
.pr-detail-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pr-detail-header {
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.pr-detail-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  line-height: 1.4;
}

.pr-detail-subtitle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.pr-detail-tabs {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.pr-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: color 0.12s, border-color 0.12s;
  margin-bottom: -1px;
}

.pr-tab:hover { color: var(--color-text); }
.pr-tab.active { color: var(--color-accent); border-bottom-color: var(--color-accent); }

.pr-tab-count {
  font-size: 10px;
  background: var(--color-bg-tertiary);
  border-radius: 8px;
  padding: 0 5px;
  min-width: 16px;
  text-align: center;
  color: var(--color-text-muted);
}

.pr-tab-spacer { flex: 1; }

.pr-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Info tab */
.pr-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.pr-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
}

.pr-stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted);
}

.pr-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.pr-reviewer-list, .pr-label-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.pr-body-text {
  font-size: 12px;
  line-height: 1.6;
  padding: 10px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  max-height: 200px;
  overflow-y: auto;
  word-break: break-word;
}

.pr-body-text :deep(.pr-code) {
  background: rgba(203,166,247,0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 11px;
}

.pr-links {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* Diff tab */
.pr-diff-body {
  flex-direction: row !important;
  padding: 0 !important;
  gap: 0 !important;
}

.pr-diff-sidebar {
  width: 200px;
  min-width: 160px;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  padding: 8px;
  flex-shrink: 0;
}

.pr-diff-file-count {
  font-size: 11px;
  color: var(--color-text-muted);
  padding-bottom: 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
}

.pr-diff-file {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: none;
  text-align: left;
  color: var(--color-text);
  transition: background 0.1s;
  margin-bottom: 2px;
}

.pr-diff-file:hover { background: var(--color-bg-tertiary); }
.pr-diff-file.active { background: rgba(203,166,247,0.12); }

.pr-diff-file-name { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-diff-file-path { font-size: 10px; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.pr-diff-viewer {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

/* CI tab */
.pr-checks { display: flex; flex-direction: column; gap: 4px; }

.pr-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
}

.pr-check-icon { font-size: 14px; flex-shrink: 0; }
.pr-check-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-check-state { font-size: 11px; color: var(--color-text-muted); text-transform: uppercase; }

/* ─── Shared button system ───────────────────────────── */
.eco-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font-size: 12px;
  padding: 5px 10px;
  transition: background 0.12s, border-color 0.12s;
  white-space: nowrap;
}

.eco-btn:hover { background: var(--color-bg-tertiary); }
.eco-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.eco-btn--primary { background: var(--color-accent); color: #1e1e2e; border-color: transparent; font-weight: 600; }
.eco-btn--primary:hover { filter: brightness(1.1); background: var(--color-accent); }
.eco-btn--xs { font-size: 11px; padding: 3px 8px; border-radius: 5px; }
.eco-close { padding: 5px; border-color: transparent; color: var(--color-text-muted); }
.eco-close:hover { color: var(--color-text); background: var(--color-bg-tertiary); }

.eco-input {
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}

.eco-input:focus { border-color: var(--color-accent); }
.eco-input--sm { font-size: 12px; padding: 5px 8px; flex: 1; }
.eco-textarea { resize: vertical; min-height: 52px; }

.mono { font-family: "JetBrains Mono", "Fira Code", monospace; }
</style>
