<script setup lang="ts">
/**
 * PrDetailView.vue
 *
 * Full PR detail rendered in <main> when viewMode === "prs".
 * Injects the shared usePrPanel composable. No modal wrapper — fills the main area.
 */
import { inject } from "vue";
import { PR_PANEL_KEY, type PrPanelState } from "../composables/usePrPanel";
import type { CICheck } from "../utils/backend";
import PrInlineDiff from "./PrInlineDiff.vue";
import PrReviewModal from "./PrReviewModal.vue";
import PrIntelligencePanel from "./PrIntelligencePanel.vue";

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "navigate-commit", hash: string): void;
}>();

const p = inject<PrPanelState>(PR_PANEL_KEY)!;

function openInBrowser(url: string) { window.open(url, "_blank"); }
</script>

<template>
  <div class="pdv-root">
    <!-- Merge dialog -->
    <div v-if="p.mergingPr.value" class="pdv-merge-dialog">
      <p>Merger la PR <strong>#{{ p.mergingPr.value.number }}</strong> — {{ p.mergingPr.value.title }}</p>
      <div class="pdv-merge-options">
        <label><input type="radio" v-model="p.mergeMethod.value" value="merge" /> Merge commit</label>
        <label><input type="radio" v-model="p.mergeMethod.value" value="squash" /> Squash and merge</label>
        <label><input type="radio" v-model="p.mergeMethod.value" value="rebase" /> Rebase and merge</label>
      </div>
      <div class="pdv-merge-actions">
        <button class="eco-btn eco-btn--primary" @click="p.mergePr">Merger</button>
        <button class="eco-btn" @click="p.mergingPr.value = null">Annuler</button>
      </div>
    </div>

    <!-- Messages -->
    <div v-if="p.error.value" class="pdv-msg pdv-msg--error">{{ p.error.value }}</div>
    <div v-if="p.success.value" class="pdv-msg pdv-msg--success" @click="p.success.value = null">{{ p.success.value }}</div>

    <!-- Empty state -->
    <div v-if="!p.selectedPr.value" class="pdv-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25">
        <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
        <path d="M6 9v6M18 15V9a3 3 0 0 0-3-3H9"/>
      </svg>
      <span>Sélectionnez une PR dans la liste</span>
    </div>

    <!-- Detail loading -->
    <div v-else-if="p.detailLoading.value && !p.prDetail.value" class="pdv-empty">
      Chargement des détails…
    </div>

    <!-- Detail error -->
    <div v-else-if="p.detailError.value && !p.prDetail.value" class="pdv-msg pdv-msg--error pdv-msg--full">
      {{ p.detailError.value }}
    </div>

    <!-- Detail content -->
    <template v-else-if="p.prDetail.value">
      <!-- Header bar -->
      <div class="pdv-header">
        <div class="pdv-header-main">
          <span class="pdv-pr-num">#{{ p.prDetail.value.number }}</span>
          <span class="pdv-pr-title">{{ p.prDetail.value.title }}</span>
        </div>
        <div class="pdv-header-meta">
          <span>{{ p.prDetail.value.author }}</span>
          <span class="mono">{{ p.prDetail.value.branch }} → {{ p.prDetail.value.base }}</span>
          <span>{{ p.timeAgo(p.prDetail.value.createdAt) }}</span>
          <span v-if="p.prDetail.value.mergedAt">· Mergée {{ p.timeAgo(p.prDetail.value.mergedAt) }}</span>
        </div>
        <div class="pdv-header-actions">
          <button
            class="eco-btn eco-btn--xs"
            @click="p.checkoutPr(p.selectedPr.value!)"
          >Checkout</button>
          <button
            v-if="p.selectedPr.value?.state === 'OPEN' || p.selectedPr.value?.state === 'open'"
            class="eco-btn eco-btn--xs eco-btn--primary"
            @click="p.mergingPr.value = p.selectedPr.value"
          >Merger</button>
          <button class="eco-btn eco-btn--xs" @click="openInBrowser(p.prDetail.value.url)">↗ GitHub</button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="pdv-tabs">
        <button :class="['pdv-tab', { active: p.detailTab.value === 'info' }]" @click="p.detailTab.value = 'info'">Info</button>
        <button :class="['pdv-tab', { active: p.detailTab.value === 'diff' }]" @click="p.detailTab.value = 'diff'">
          Diff
          <span v-if="p.prDetail.value.changedFiles" class="pdv-tab-count">{{ p.prDetail.value.changedFiles }}</span>
          <span v-if="p.commentCount.value" class="pdv-tab-count pdv-tab-count--comment">💬{{ p.commentCount.value }}</span>
        </button>
        <button :class="['pdv-tab', { active: p.detailTab.value === 'checks' }]" @click="p.detailTab.value = 'checks'">
          {{ p.checksIcon(p.prDetail.value.checksStatus) }} CI
          <span v-if="p.prChecks.value.length" class="pdv-tab-count">{{ p.prChecks.value.length }}</span>
        </button>
        <button :class="['pdv-tab', { active: p.detailTab.value === 'intelligence' }]" @click="p.detailTab.value = 'intelligence'">
          🧠 Intelligence
        </button>
        <div class="pdv-tab-spacer" />
        <button
          class="eco-btn eco-btn--xs pdv-review-btn"
          :class="p.draftReviewComments.value.length ? 'eco-btn--primary' : ''"
          @click="p.showReviewModal.value = true"
        >
          ✍️ Review{{ p.draftReviewComments.value.length ? ` (${p.draftReviewComments.value.length})` : '' }}
        </button>
      </div>

      <!-- Tab content -->
      <div class="pdv-content">

        <!-- Info tab -->
        <div v-if="p.detailTab.value === 'info'" class="pdv-body pdv-info">
          <!-- Merge readiness banner -->
          <div
            v-if="p.mergeReadiness.value"
            class="pdv-readiness"
            :class="p.mergeReadiness.value.ready ? 'pdv-readiness--ok' : 'pdv-readiness--wait'"
          >
            <span>{{ p.mergeReadiness.value.ready ? '✅' : '⏳' }}</span>
            <span>{{ p.mergeReadiness.value.reason }}</span>
          </div>

          <div class="pdv-stats-grid">
            <div class="pdv-stat">
              <span class="pdv-stat-label">Merge</span>
              <span>{{ p.mergeableIcon(p.prDetail.value.mergeable) }} {{ p.prDetail.value.mergeable }}</span>
            </div>
            <div class="pdv-stat">
              <span class="pdv-stat-label">Fichiers</span>
              <span>{{ p.prDetail.value.changedFiles }}</span>
            </div>
            <div class="pdv-stat">
              <span class="pdv-stat-label">Diff</span>
              <span>
                <span class="pdv-add">+{{ p.prDetail.value.additions }}</span>
                <span class="pdv-del"> -{{ p.prDetail.value.deletions }}</span>
              </span>
            </div>
            <div class="pdv-stat">
              <span class="pdv-stat-label">Commentaires</span>
              <span>{{ p.prDetail.value.comments + p.prDetail.value.reviewComments }}</span>
            </div>
          </div>

          <div v-if="p.prDetail.value.reviewers.length" class="pdv-section">
            <span class="pdv-section-label">Reviewers</span>
            <div class="pdv-chips">
              <span v-for="r in p.prDetail.value.reviewers" :key="r" class="pdv-chip">{{ r }}</span>
            </div>
          </div>

          <div v-if="p.prDetail.value.labels.length" class="pdv-section">
            <span class="pdv-section-label">Labels</span>
            <div class="pdv-chips">
              <span v-for="l in p.prDetail.value.labels" :key="l" class="pdv-chip">{{ l }}</span>
            </div>
          </div>

          <div class="pdv-section-label">Description</div>
          <div v-if="p.prDetail.value.body" class="pdv-body-text" v-html="p.renderBody(p.prDetail.value.body)" />
          <div v-else class="pdv-muted">Aucune description.</div>

          <div class="pdv-links">
            <button class="eco-btn eco-btn--xs" @click="openInBrowser(p.prDetail.value.url + '/commits')">📦 Commits</button>
            <button class="eco-btn eco-btn--xs" @click="openInBrowser(p.prDetail.value.url + '/files')">📄 Fichiers</button>
            <button v-if="p.prDetail.value.checksStatus" class="eco-btn eco-btn--xs" @click="openInBrowser(p.prDetail.value.url + '/checks')">🔗 CI</button>
          </div>
        </div>

        <!-- Diff tab -->
        <div v-else-if="p.detailTab.value === 'diff'" class="pdv-body pdv-diff-body">
          <div v-if="p.detailLoading.value && !p.prDiffFiles.value.length" class="pdv-loading">Chargement du diff…</div>
          <template v-else-if="p.prDiffFiles.value.length">
            <!-- File sidebar -->
            <div class="pdv-diff-sidebar">
              <div class="pdv-diff-count">{{ p.prDiffFiles.value.length }} fichier{{ p.prDiffFiles.value.length > 1 ? 's' : '' }}</div>
              <button
                v-for="file in p.prDiffFiles.value"
                :key="file.path"
                :class="['pdv-diff-file', { active: p.selectedDiffFile.value === file.path }]"
                @click="p.selectedDiffFile.value = file.path"
              >
                <div class="pdv-diff-file-top">
                  <span class="pdv-diff-file-name">{{ file.path.split('/').pop() }}</span>
                  <span
                    v-if="p.prComments.value.filter(c => c.path === file.path).length"
                    class="pdv-diff-file-comments"
                  >💬{{ p.prComments.value.filter(c => c.path === file.path).length }}</span>
                </div>
                <span class="pdv-diff-file-path">{{ file.path }}</span>
              </button>
            </div>
            <!-- Diff viewer -->
            <div class="pdv-diff-viewer">
              <PrInlineDiff
                v-if="p.selectedDiff.value"
                :diff="p.selectedDiff.value"
                :file-path="p.selectedDiffFile.value"
                :comments="p.commentsForFile.value"
                :current-user="undefined"
                :review-draft-count="p.draftReviewComments.value.length"
                @create-comment="p.handleCreateComment"
                @add-to-review="p.handleAddToReview"
                @reply-comment="p.handleReplyComment"
                @edit-comment="p.handleEditComment"
                @delete-comment="p.handleDeleteComment"
                @apply-suggestion="p.handleApplySuggestion"
              />
            </div>
          </template>
          <div v-else class="pdv-loading">Aucun diff disponible.</div>
        </div>

        <!-- CI tab -->
        <div v-else-if="p.detailTab.value === 'checks'" class="pdv-body pdv-checks-body">
          <div v-if="p.prChecks.value.length === 0" class="pdv-loading">Aucun check CI trouvé.</div>
          <div v-else class="pdv-checks">
            <div v-for="c in p.prChecks.value" :key="c.name" class="pdv-check">
              <span class="pdv-check-icon">{{ p.checkIcon(c) }}</span>
              <span class="pdv-check-name">{{ c.name }}</span>
              <span class="pdv-check-state">{{ c.conclusion || c.state }}</span>
              <button v-if="c.detailsUrl" class="eco-btn eco-btn--xs" @click="openInBrowser(c.detailsUrl)">↗</button>
            </div>
          </div>
        </div>

        <!-- Intelligence tab -->
        <div v-else-if="p.detailTab.value === 'intelligence'" class="pdv-body pdv-intelligence-body">
          <PrIntelligencePanel
            :cwd="''"
            :pr-detail="p.prDetail.value"
            :pr-diff-files="p.prDiffFiles.value"
            :total-repo-files="p.totalRepoFiles.value"
            :conflict-preview="p.conflictPreview.value"
            :conflict-loading="p.conflictLoading.value"
            :conflict-error="p.conflictError.value"
            :hotspots="p.hotspots.value"
            :hotspots-loading="p.hotspotsLoading.value"
            :file-history="p.fileHistory.value"
            :file-history-loading="p.fileHistoryLoading.value"
            @load-conflict-preview="p.loadConflictPreview"
            @load-hotspots="p.loadHotspots"
            @load-file-history="p.loadFileHistory"
          />
        </div>
      </div>
    </template>

    <!-- Review modal -->
    <Teleport to="body">
      <PrReviewModal
        v-if="p.showReviewModal.value && p.selectedPr.value"
        :pr-number="p.selectedPr.value.number"
        :draft-comments="p.draftReviewComments.value"
        :submitting="p.submittingReview.value"
        @submit="p.handleSubmitReview"
        @close="p.showReviewModal.value = false"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.pdv-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--color-bg);
}

/* Merge dialog */
.pdv-merge-dialog {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  flex-shrink: 0;
}
.pdv-merge-dialog p { margin: 0 0 8px; font-size: 13px; }
.pdv-merge-options { display: flex; gap: 16px; margin-bottom: 10px; }
.pdv-merge-options label { font-size: 12px; display: flex; align-items: center; gap: 5px; cursor: pointer; }
.pdv-merge-actions { display: flex; gap: 6px; }

/* Messages */
.pdv-msg {
  font-size: 12px;
  padding: 6px 16px;
  flex-shrink: 0;
}
.pdv-msg--error { color: var(--color-danger); background: var(--color-danger-soft); }
.pdv-msg--success { color: var(--color-success); background: var(--color-success-soft); cursor: pointer; }
.pdv-msg--full { padding: 16px; font-size: 13px; }

/* Empty state */
.pdv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--color-text-muted);
  font-size: 14px;
}

/* Header bar */
.pdv-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 20px 10px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  background: var(--color-bg-secondary);
}

.pdv-header-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.pdv-pr-num {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-accent);
  font-family: monospace;
  flex-shrink: 0;
}

.pdv-pr-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.3;
}

.pdv-header-meta {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.pdv-header-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

/* Tabs */
.pdv-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.pdv-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 12px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.pdv-tab:hover { color: var(--color-text); }
.pdv-tab.active { color: var(--color-accent); border-bottom-color: var(--color-accent); font-weight: 600; }

.pdv-tab-count {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-weight: 600;
}
.pdv-tab-count--comment { background: var(--color-accent-soft); color: var(--color-accent); }

.pdv-tab-spacer { flex: 1; }
.pdv-review-btn { margin: 4px 0; font-weight: 600; }

/* Content area */
.pdv-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.pdv-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

/* Info tab */
.pdv-info { display: flex; flex-direction: column; gap: 14px; }

.pdv-readiness {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
}
.pdv-readiness--ok { background: var(--color-success-soft); border: 1px solid var(--color-success); color: var(--color-success); }
.pdv-readiness--wait { background: var(--color-warning-soft); border: 1px solid var(--color-warning); color: var(--color-warning); font-weight: 600; }

.pdv-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.pdv-stat {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pdv-stat-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.pdv-add { color: var(--color-success); font-weight: 600; }
.pdv-del { color: var(--color-danger); font-weight: 600; }

.pdv-section { display: flex; flex-direction: column; gap: 6px; }
.pdv-section-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.pdv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pdv-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.pdv-body-text {
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.6;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px 14px;
}

.pdv-muted { font-size: 12px; color: var(--color-text-muted); font-style: italic; }

.pdv-links { display: flex; gap: 6px; }

.pdv-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--color-text-muted);
  padding: 24px;
}

/* Diff tab */
.pdv-diff-body {
  display: flex;
  padding: 0;
  overflow: hidden;
  flex: 1;
}

.pdv-diff-sidebar {
  width: 220px;
  min-width: 180px;
  border-right: 1px solid var(--color-border);
  overflow-y: auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 4px;
  background: var(--color-bg-secondary);
}

.pdv-diff-count {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 4px 8px 6px;
}

.pdv-diff-file {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  color: var(--color-text);
  width: 100%;
}
.pdv-diff-file:hover { background: var(--color-bg-tertiary); }
.pdv-diff-file.active { background: var(--color-accent-soft); border-color: var(--color-accent); }

.pdv-diff-file-top { display: flex; align-items: center; gap: 4px; overflow: hidden; }
.pdv-diff-file-name { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.pdv-diff-file-comments { font-size: 10px; color: var(--color-accent); flex-shrink: 0; }
.pdv-diff-file-path { font-size: 10px; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.pdv-diff-viewer { flex: 1; overflow: auto; }

/* CI tab */
.pdv-checks-body { overflow-y: auto; }
.pdv-checks { display: flex; flex-direction: column; gap: 4px; }
.pdv-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 12px;
}
.pdv-check-icon { font-size: 14px; flex-shrink: 0; }
.pdv-check-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdv-check-state { font-size: 11px; color: var(--color-text-muted); text-transform: uppercase; }

/* Intelligence tab */
.pdv-intelligence-body {
  padding: 0;
  overflow: hidden;
  flex: 1;
}

/* ── Action buttons (eco-btn) ─────────────────────────── */
.eco-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  line-height: 1.4;
}
.eco-btn:hover {
  background: var(--color-bg);
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.eco-btn--xs {
  padding: 3px 9px;
  font-size: 11px;
  border-radius: 5px;
}
.eco-btn--primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text);
}
.eco-btn--primary:hover {
  background: var(--color-accent-hover, color-mix(in srgb, var(--color-accent) 85%, #000));
  border-color: var(--color-accent-hover, var(--color-accent));
  color: var(--color-accent-text);
}
</style>
