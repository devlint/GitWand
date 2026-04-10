<script setup lang="ts">
/**
 * PrIntelligencePanel.vue — Phase 9.4
 *
 * The "🧠 Intelligence" tab for PR review.
 * Shows:
 *  1. Conflict prediction (git merge-tree analysis)
 *  2. Review scope (risk level, % codebase touched)
 *  3. Hotspot analysis (files with high merge-conflict history)
 *  4. AI review suggestions (complex hunks, detected statically)
 *  5. File review history (who reviewed what in this file before)
 */
import { ref, computed, watch } from "vue";
import type {
  PrConflictPreview,
  PrHotspot,
  PrFileHistory,
  PullRequestDetail,
  GitDiff,
} from "../utils/backend";

const props = defineProps<{
  cwd: string;
  prDetail: PullRequestDetail;
  prDiffFiles: GitDiff[];
  /** Total tracked files in repo (for scope %). */
  totalRepoFiles: number;
  /** Conflict prediction result (loaded on demand). */
  conflictPreview: PrConflictPreview | null;
  conflictLoading: boolean;
  conflictError: string | null;
  /** Hotspot data per file. */
  hotspots: PrHotspot[];
  hotspotsLoading: boolean;
  /** File review history keyed by path. */
  fileHistory: Record<string, PrFileHistory>;
  fileHistoryLoading: boolean;
}>();

const emit = defineEmits<{
  (e: "load-conflict-preview"): void;
  (e: "load-hotspots"): void;
  (e: "load-file-history"): void;
}>();

// ─── Review scope ────────────────────────────────────────
const scope = computed(() => {
  const changedFiles = props.prDetail.changedFiles;
  const additions = props.prDetail.additions;
  const deletions = props.prDetail.deletions;
  const totalLines = additions + deletions;
  const pct = props.totalRepoFiles > 0
    ? Math.round((changedFiles / props.totalRepoFiles) * 100)
    : null;

  // Risk level heuristic
  let risk: "low" | "medium" | "high" | "critical" = "low";
  if (totalLines > 1000 || changedFiles > 30) risk = "critical";
  else if (totalLines > 300 || changedFiles > 10) risk = "high";
  else if (totalLines > 100 || changedFiles > 3) risk = "medium";

  const riskLabel: Record<string, string> = {
    low: "Faible",
    medium: "Modéré",
    high: "Élevé",
    critical: "Critique",
  };
  const riskColor: Record<string, string> = {
    low: "#a6e3a1",
    medium: "#f9e2af",
    high: "#fab387",
    critical: "#f38ba8",
  };

  return { changedFiles, additions, deletions, totalLines, pct, risk, riskLabel: riskLabel[risk], riskColor: riskColor[risk] };
});

// ─── Hotspot summary ──────────────────────────────────────
const topHotspots = computed(() =>
  [...props.hotspots]
    .sort((a, b) => b.mergeCount - a.mergeCount)
    .filter((h) => h.mergeCount > 0)
    .slice(0, 5),
);

// ─── AI suggestion detection (static analysis) ───────────
interface AiFlag {
  file: string;
  reason: string;
  severity: "info" | "warn" | "error";
}

const aiFlags = computed<AiFlag[]>(() => {
  const flags: AiFlag[] = [];
  for (const diff of props.prDiffFiles) {
    const totalAdded = diff.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === "add").length, 0);
    const totalDeleted = diff.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === "delete").length, 0);

    if (totalAdded + totalDeleted > 200) {
      flags.push({ file: diff.path, reason: `Fichier très modifié (${totalAdded + totalDeleted} lignes changées) — review attentive recommandée.`, severity: "warn" });
    }

    // Detect potential breaking changes: removed exports, deleted function signatures
    const deletedLines = diff.hunks.flatMap((h) => h.lines.filter((l) => l.type === "delete").map((l) => l.content));
    const hasExportRemoval = deletedLines.some((l) => /^\s*(export\s+(default|const|function|class)|module\.exports|def |pub fn |public )/.test(l));
    if (hasExportRemoval) {
      flags.push({ file: diff.path, reason: "Suppression d'export/API publique détectée — risque de breaking change.", severity: "error" });
    }

    // Detect config/env file changes
    if (/\.(env|config|yaml|yml|toml|json|lock)$/.test(diff.path)) {
      flags.push({ file: diff.path, reason: "Fichier de configuration modifié — vérifier l'impact sur les autres environnements.", severity: "info" });
    }

    // Detect migration files
    if (/migrat|schema\.sql|\.sql$/.test(diff.path.toLowerCase())) {
      flags.push({ file: diff.path, reason: "Migration de base de données détectée — vérifier la réversibilité.", severity: "warn" });
    }

    // Large single hunk
    for (const hunk of diff.hunks) {
      if (hunk.lines.length > 100) {
        flags.push({ file: diff.path, reason: `Hunk de ${hunk.lines.length} lignes — difficile à reviewer d'un seul coup.`, severity: "info" });
        break; // Only once per file
      }
    }
  }
  return flags;
});

// Auto-load hotspots and file history when component mounts
// (conflict preview is on-demand since it requires git fetch)
watch(() => props.prDiffFiles, (files) => {
  if (files.length > 0) {
    if (!props.hotspots.length && !props.hotspotsLoading) emit("load-hotspots");
    if (!Object.keys(props.fileHistory).length && !props.fileHistoryLoading) emit("load-file-history");
  }
}, { immediate: true });
</script>

<template>
  <div class="pi-root">

    <!-- ── Conflict Prediction ────────────────────────────── -->
    <section class="pi-section">
      <div class="pi-section-header">
        <span class="pi-section-icon">🔀</span>
        <span class="pi-section-title">Conflict Prediction</span>
        <span class="pi-badge pi-badge--info">git merge-tree</span>
        <div class="pi-spacer" />
        <button
          v-if="!conflictPreview && !conflictLoading"
          class="pi-action-btn"
          @click="emit('load-conflict-preview')"
        >Analyser</button>
        <span v-if="conflictLoading" class="pi-loading">Analyse en cours…</span>
      </div>

      <div v-if="conflictError" class="pi-msg pi-msg--error">{{ conflictError }}</div>

      <div v-if="!conflictPreview && !conflictLoading && !conflictError" class="pi-empty">
        Cliquez sur « Analyser » pour simuler le merge et détecter les conflits potentiels
        <em>sans toucher au working tree</em>.
      </div>

      <template v-if="conflictPreview">
        <!-- Summary pill -->
        <div
          class="pi-conflict-summary"
          :class="conflictPreview.conflictingFiles.length > 0 ? 'pi-conflict-summary--bad' : 'pi-conflict-summary--ok'"
        >
          {{ conflictPreview.summary }}
        </div>

        <div v-if="conflictPreview.overlappingFiles.length > 0" class="pi-conflict-detail">
          <div class="pi-subsection-label">Fichiers modifiés des deux côtés (risque de conflit)</div>
          <div class="pi-file-list">
            <div
              v-for="f in conflictPreview.overlappingFiles"
              :key="f"
              class="pi-file-row"
              :class="conflictPreview.conflictingFiles.includes(f) ? 'pi-file-row--conflict' : 'pi-file-row--overlap'"
            >
              <span class="pi-file-icon">
                {{ conflictPreview.conflictingFiles.includes(f) ? '⚠️' : '⚡' }}
              </span>
              <span class="pi-file-name mono">{{ f }}</span>
              <span class="pi-file-label">
                {{ conflictPreview.conflictingFiles.includes(f) ? 'Conflit probable' : 'Chevauchement' }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="conflictPreview.cleanFiles.length > 0" class="pi-conflict-detail">
          <div class="pi-subsection-label">Fichiers sans risque ({{ conflictPreview.cleanFiles.length }})</div>
          <div class="pi-file-list pi-file-list--compact">
            <span v-for="f in conflictPreview.cleanFiles.slice(0, 8)" :key="f" class="pi-chip pi-chip--clean">
              {{ f.split('/').pop() }}
            </span>
            <span v-if="conflictPreview.cleanFiles.length > 8" class="pi-chip pi-chip--more">
              +{{ conflictPreview.cleanFiles.length - 8 }}
            </span>
          </div>
        </div>
      </template>
    </section>

    <!-- ── Review Scope ───────────────────────────────────── -->
    <section class="pi-section">
      <div class="pi-section-header">
        <span class="pi-section-icon">📐</span>
        <span class="pi-section-title">Review Scope</span>
        <span
          class="pi-badge"
          :style="{ background: scope.riskColor + '22', color: scope.riskColor, borderColor: scope.riskColor + '55' }"
        >{{ scope.riskLabel }}</span>
      </div>

      <div class="pi-scope-grid">
        <div class="pi-scope-card">
          <div class="pi-scope-value">{{ scope.changedFiles }}</div>
          <div class="pi-scope-label">fichiers</div>
        </div>
        <div class="pi-scope-card">
          <div class="pi-scope-value">
            <span class="pi-add">+{{ scope.additions }}</span>
            <span class="pi-del"> -{{ scope.deletions }}</span>
          </div>
          <div class="pi-scope-label">lignes</div>
        </div>
        <div v-if="scope.pct !== null" class="pi-scope-card">
          <div class="pi-scope-value">{{ scope.pct }}%</div>
          <div class="pi-scope-label">de la codebase</div>
        </div>
        <div class="pi-scope-card">
          <div class="pi-scope-value">{{ scope.totalLines }}</div>
          <div class="pi-scope-label">lignes totales</div>
        </div>
      </div>

      <!-- Risk bar -->
      <div class="pi-risk-bar-track">
        <div
          class="pi-risk-bar-fill"
          :style="{
            width: Math.min(100, Math.round((scope.totalLines / 1000) * 100)) + '%',
            background: scope.riskColor,
          }"
        />
      </div>
      <div class="pi-risk-hint">
        <span v-if="scope.risk === 'low'">Changement léger — review standard.</span>
        <span v-else-if="scope.risk === 'medium'">Changement modéré — attention aux effets de bord.</span>
        <span v-else-if="scope.risk === 'high'">Changement important — review approfondie recommandée.</span>
        <span v-else>Changement très large — prévoir plusieurs sessions de review.</span>
      </div>
    </section>

    <!-- ── Hotspot Analysis ───────────────────────────────── -->
    <section class="pi-section">
      <div class="pi-section-header">
        <span class="pi-section-icon">🔥</span>
        <span class="pi-section-title">Hotspot Analysis</span>
        <span class="pi-badge pi-badge--info">historique git</span>
        <div class="pi-spacer" />
        <span v-if="hotspotsLoading" class="pi-loading">Chargement…</span>
      </div>

      <div v-if="topHotspots.length === 0 && !hotspotsLoading" class="pi-empty">
        Aucun fichier de la PR n'a d'historique de merge-conflict.
      </div>

      <div v-if="topHotspots.length > 0" class="pi-hotspot-list">
        <div v-for="h in topHotspots" :key="h.path" class="pi-hotspot-row">
          <span class="pi-hotspot-fire">{{ h.score > 50 ? '🔥' : h.score > 20 ? '⚡' : '📄' }}</span>
          <span class="pi-hotspot-name mono">{{ h.path.split('/').pop() }}</span>
          <div class="pi-hotspot-bar-track">
            <div
              class="pi-hotspot-bar-fill"
              :style="{ width: Math.min(100, h.score) + '%' }"
            />
          </div>
          <span class="pi-hotspot-count">{{ h.mergeCount }} merge{{ h.mergeCount > 1 ? 's' : '' }}</span>
        </div>
      </div>

      <div v-if="hotspots.length > 0 && topHotspots.length === 0" class="pi-empty">
        ✅ Aucun fichier à risque dans cette PR.
      </div>
    </section>

    <!-- ── AI Review Suggestions ──────────────────────────── -->
    <section class="pi-section">
      <div class="pi-section-header">
        <span class="pi-section-icon">🤖</span>
        <span class="pi-section-title">Suggestions de review</span>
        <span class="pi-badge pi-badge--ai">Analyse statique</span>
      </div>

      <div v-if="aiFlags.length === 0" class="pi-empty">
        ✅ Aucune anomalie détectée dans les patterns de code.
      </div>

      <div v-else class="pi-ai-list">
        <div
          v-for="(flag, i) in aiFlags"
          :key="i"
          class="pi-ai-row"
          :class="`pi-ai-row--${flag.severity}`"
        >
          <span class="pi-ai-icon">
            {{ flag.severity === 'error' ? '🚨' : flag.severity === 'warn' ? '⚠️' : 'ℹ️' }}
          </span>
          <div class="pi-ai-content">
            <span class="pi-ai-file mono">{{ flag.file.split('/').pop() }}</span>
            <span class="pi-ai-reason">{{ flag.reason }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── File Review History ─────────────────────────────── -->
    <section class="pi-section">
      <div class="pi-section-header">
        <span class="pi-section-icon">📜</span>
        <span class="pi-section-title">Historique de review</span>
        <div class="pi-spacer" />
        <span v-if="fileHistoryLoading" class="pi-loading">Chargement…</span>
      </div>

      <div v-if="Object.keys(fileHistory).length === 0 && !fileHistoryLoading" class="pi-empty">
        Aucun historique de review disponible pour ces fichiers.
      </div>

      <div v-else class="pi-history-list">
        <template v-for="(hist, filePath) in fileHistory" :key="filePath">
          <div v-if="hist.reviewCommentCount > 0" class="pi-history-row">
            <div class="pi-history-file mono">{{ String(filePath).split('/').pop() }}</div>
            <div class="pi-history-meta">
              <span class="pi-history-count">💬 {{ hist.reviewCommentCount }}</span>
              <span v-if="hist.reviewers.length" class="pi-history-reviewers">
                par {{ hist.reviewers.slice(0, 3).join(', ') }}{{ hist.reviewers.length > 3 ? ` +${hist.reviewers.length - 3}` : '' }}
              </span>
            </div>
            <div v-if="hist.lastComment" class="pi-history-last">
              Dernier : <em>{{ hist.lastComment.body }}…</em>
              <span v-if="hist.lastComment.pr_number" class="pi-history-pr">PR #{{ hist.lastComment.pr_number }}</span>
            </div>
          </div>
        </template>
        <div
          v-if="Object.values(fileHistory).every((h) => h.reviewCommentCount === 0)"
          class="pi-empty"
        >
          ✅ Aucun de ces fichiers n'a été commenté dans les reviews précédentes.
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
.pi-root {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
  height: 100%;
}

/* Sections */
.pi-section {
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
}
.pi-section:last-child { border-bottom: none; }

.pi-section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.pi-section-icon { font-size: 15px; }
.pi-section-title { font-size: 13px; font-weight: 600; color: var(--color-text); }
.pi-spacer { flex: 1; }

.pi-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 10px;
  border: 1px solid;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.pi-badge--info {
  background: rgba(137,180,250,0.1);
  color: #89b4fa;
  border-color: rgba(137,180,250,0.3);
}
.pi-badge--ai {
  background: rgba(203,166,247,0.1);
  color: var(--color-accent);
  border-color: rgba(203,166,247,0.3);
}

.pi-empty {
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
  padding: 4px 0;
}

.pi-loading { font-size: 11px; color: var(--color-text-muted); }

.pi-action-btn {
  background: var(--color-accent);
  border: none;
  border-radius: 5px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 12px;
  cursor: pointer;
}
.pi-action-btn:hover { filter: brightness(1.1); }

.pi-msg--error {
  font-size: 12px;
  color: #f38ba8;
  padding: 4px 0;
}

.pi-subsection-label {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Conflict prediction */
.pi-conflict-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 10px;
}
.pi-conflict-summary--ok {
  background: rgba(166,227,161,0.12);
  border: 1px solid rgba(166,227,161,0.35);
  color: #a6e3a1;
}
.pi-conflict-summary--bad {
  background: rgba(243,139,168,0.12);
  border: 1px solid rgba(243,139,168,0.35);
  color: #f38ba8;
}

.pi-conflict-detail { margin-bottom: 10px; }

.pi-file-list { display: flex; flex-direction: column; gap: 3px; }
.pi-file-list--compact { flex-direction: row; flex-wrap: wrap; gap: 4px; }

.pi-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 5px;
  font-size: 12px;
  background: var(--color-bg-tertiary);
}
.pi-file-row--conflict { border-left: 2px solid #f38ba8; }
.pi-file-row--overlap { border-left: 2px solid #f9e2af; }
.pi-file-icon { font-size: 13px; }
.pi-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi-file-label { font-size: 10px; color: var(--color-text-muted); white-space: nowrap; flex-shrink: 0; }

.pi-chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.pi-chip--clean { color: #a6e3a1; border-color: rgba(166,227,161,0.3); }
.pi-chip--more { color: var(--color-accent); }

/* Scope */
.pi-scope-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}

.pi-scope-card {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  padding: 8px 10px;
  text-align: center;
}
.pi-scope-value { font-size: 16px; font-weight: 700; color: var(--color-text); margin-bottom: 2px; }
.pi-scope-label { font-size: 10px; color: var(--color-text-muted); text-transform: uppercase; }
.pi-add { color: #a6e3a1; }
.pi-del { color: #f38ba8; }

.pi-risk-bar-track {
  height: 4px;
  background: var(--color-bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 5px;
}
.pi-risk-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease;
}
.pi-risk-hint { font-size: 11px; color: var(--color-text-muted); font-style: italic; }

/* Hotspots */
.pi-hotspot-list { display: flex; flex-direction: column; gap: 5px; }
.pi-hotspot-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}
.pi-hotspot-fire { font-size: 14px; flex-shrink: 0; }
.pi-hotspot-name { width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text); flex-shrink: 0; }
.pi-hotspot-bar-track {
  flex: 1;
  height: 5px;
  background: var(--color-bg-tertiary);
  border-radius: 3px;
  overflow: hidden;
}
.pi-hotspot-bar-fill {
  height: 100%;
  background: #fab387;
  border-radius: 3px;
}
.pi-hotspot-count { font-size: 11px; color: var(--color-text-muted); white-space: nowrap; width: 70px; text-align: right; flex-shrink: 0; }

/* AI flags */
.pi-ai-list { display: flex; flex-direction: column; gap: 5px; }
.pi-ai-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  border-left: 3px solid;
  background: var(--color-bg-tertiary);
  font-size: 12px;
}
.pi-ai-row--error { border-color: #f38ba8; }
.pi-ai-row--warn { border-color: #f9e2af; }
.pi-ai-row--info { border-color: #89b4fa; }
.pi-ai-icon { font-size: 13px; flex-shrink: 0; margin-top: 1px; }
.pi-ai-content { display: flex; flex-direction: column; gap: 2px; }
.pi-ai-file { font-weight: 600; color: var(--color-text); font-size: 11px; }
.pi-ai-reason { color: var(--color-text); line-height: 1.4; }

/* File history */
.pi-history-list { display: flex; flex-direction: column; gap: 6px; }
.pi-history-row {
  padding: 7px 10px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  border: 1px solid var(--color-border);
  font-size: 12px;
}
.pi-history-file { font-weight: 600; color: var(--color-text); margin-bottom: 2px; }
.pi-history-meta { display: flex; gap: 8px; align-items: center; color: var(--color-text-muted); }
.pi-history-count { color: var(--color-accent); font-weight: 600; }
.pi-history-reviewers { font-size: 11px; }
.pi-history-last {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pi-history-pr {
  margin-left: 6px;
  color: var(--color-accent);
  font-weight: 600;
}
</style>
