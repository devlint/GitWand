<script setup lang="ts">
/**
 * PrIntelligencePanel.vue — Phase 9.4
 *
 * The "Intelligence" tab for PR review.
 * Shows:
 *  1. Conflict prediction (git merge-tree analysis)
 *  2. Review scope (risk level, % codebase touched)
 *  3. Hotspot analysis (files with high merge-conflict history)
 *  4. AI review suggestions (complex hunks, detected statically)
 *  5. File review history (who reviewed what in this file before)
 *
 * Visual language aligns with PrDetailView:
 *  - Section icons in accent-soft tiles (no emojis)
 *  - Stat cards mirror .pdv-stat (icon tile + uppercase label + big value,
 *    radial hover gradient, subtle lift)
 *  - Severity is carried by `border-left` color on list rows + inline SVGs
 *  - Respects prefers-reduced-motion
 */
import { computed, watch } from "vue";
import type {
  PrConflictPreview,
  PrHotspot,
  PrFileHistory,
  PullRequestDetail,
  GitDiff,
} from "../utils/backend";
import type { ReviewFinding } from "../composables/usePrPreReview";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

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
  /** AI pre-review findings (C4, v3.6.0) — confidence-sorted, already
   *  threshold/cap/dismissal-filtered by `usePrPanel`. */
  preReviewFindings: ReviewFinding[];
  preReviewProgress: { done: number; total: number };
  preReviewRunning: boolean;
}>();

const emit = defineEmits<{
  (e: "load-conflict-preview"): void;
  (e: "load-hotspots"): void;
  (e: "load-file-history"): void;
  (e: "dismiss-finding", id: string): void;
  (e: "jump-to-finding", path: string, line: number): void;
}>();

/** Map a finding's open severity scale onto the existing error/warn/info
 *  row modifiers (`.pi-ai-row--*`) so it visually matches the static-flags
 *  list above it. */
function findingRowSeverity(sev: ReviewFinding["severity"]): "error" | "warn" | "info" {
  return sev === "risk" ? "error" : sev === "suggestion" ? "warn" : "info";
}

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
    low: t("pr.intel.riskLow"),
    medium: t("pr.intel.riskMedium"),
    high: t("pr.intel.riskHigh"),
    critical: t("pr.intel.riskCritical"),
  };
  const riskColor: Record<string, string> = {
    low: "var(--color-success)",
    medium: "var(--color-warning)",
    high: "#ea580c",
    critical: "var(--color-danger)",
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

/** Bucket a hotspot score into a severity tier for icon + bar colour. */
function hotspotTier(score: number): "high" | "medium" | "low" {
  if (score > 50) return "high";
  if (score > 20) return "medium";
  return "low";
}

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
      flags.push({ file: diff.path, reason: t("pr.intel.flagBigFile", totalAdded + totalDeleted), severity: "warn" });
    }

    // Detect potential breaking changes: removed exports, deleted function signatures
    const deletedLines = diff.hunks.flatMap((h) => h.lines.filter((l) => l.type === "delete").map((l) => l.content));
    const hasExportRemoval = deletedLines.some((l) => /^\s*(export\s+(default|const|function|class)|module\.exports|def |pub fn |public )/.test(l));
    if (hasExportRemoval) {
      flags.push({ file: diff.path, reason: t("pr.intel.flagExportRemoved"), severity: "error" });
    }

    // Detect config/env file changes
    if (/\.(env|config|yaml|yml|toml|json|lock)$/.test(diff.path)) {
      flags.push({ file: diff.path, reason: t("pr.intel.flagConfigChange"), severity: "info" });
    }

    // Detect migration files
    if (/migrat|schema\.sql|\.sql$/.test(diff.path.toLowerCase())) {
      flags.push({ file: diff.path, reason: t("pr.intel.flagDbMigration"), severity: "warn" });
    }

    // Large single hunk
    for (const hunk of diff.hunks) {
      if (hunk.lines.length > 100) {
        flags.push({ file: diff.path, reason: t("pr.intel.flagBigHunk", hunk.lines.length), severity: "info" });
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
      <header class="pi-section-header">
        <span class="pi-section-icon" aria-hidden="true">
          <!-- git merge / branches -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="4" cy="3.5" r="1.5" />
            <circle cx="12" cy="3.5" r="1.5" />
            <circle cx="8" cy="12.5" r="1.5" />
            <path d="M4 5v2.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5" />
            <path d="M8 9.5v1.5" />
          </svg>
        </span>
        <h3 class="pi-section-title">{{ t('pr.intel.conflictTitle') }}</h3>
        <span class="pi-badge pi-badge--info">git merge-tree</span>
        <div class="pi-spacer" />
        <button
          v-if="!conflictPreview && !conflictLoading"
          class="pi-action-btn"
          @click="emit('load-conflict-preview')"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 4l8 4-8 4V4z" />
          </svg>
          {{ t('pr.intel.analyze') }}
        </button>
        <span v-if="conflictLoading" class="pi-loading">
          <span class="pi-dot-spinner" aria-hidden="true"></span>
          {{ t('pr.intel.analyzing') }}
        </span>
      </header>

      <div v-if="conflictError" class="pi-msg pi-msg--error">{{ conflictError }}</div>

      <div v-if="!conflictPreview && !conflictLoading && !conflictError" class="pi-empty">
        {{ t('pr.intel.analyzeHint') }} <em>{{ t('pr.intel.analyzeHintEm') }}</em>.
      </div>

      <template v-if="conflictPreview">
        <!-- Summary banner -->
        <div
          class="pi-banner"
          :class="conflictPreview.conflictingFiles.length > 0 ? 'pi-banner--bad' : 'pi-banner--ok'"
        >
          <span class="pi-banner-icon" aria-hidden="true">
            <svg v-if="conflictPreview.conflictingFiles.length > 0" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 2l6.5 11h-13z" />
              <path d="M8 7v3M8 12v.01" />
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8l3.5 3.5L13 5" />
            </svg>
          </span>
          <span>{{ conflictPreview.summary }}</span>
        </div>

        <div v-if="conflictPreview.overlappingFiles.length > 0" class="pi-conflict-detail">
          <div class="pi-subsection-label">{{ t('pr.intel.overlappingLabel') }}</div>
          <div class="pi-file-list">
            <div
              v-for="f in conflictPreview.overlappingFiles"
              :key="f"
              class="pi-file-row"
              :class="conflictPreview.conflictingFiles.includes(f) ? 'pi-file-row--conflict' : 'pi-file-row--overlap'"
            >
              <span class="pi-file-icon" aria-hidden="true">
                <!-- ! triangle for conflict, zap for overlap -->
                <svg
                  v-if="conflictPreview.conflictingFiles.includes(f)"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M8 2l6.5 11h-13z" />
                  <path d="M8 7v3M8 12v.01" />
                </svg>
                <svg
                  v-else
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M9 2L3 9h4l-1 5 6-7H8z" />
                </svg>
              </span>
              <span class="pi-file-name mono">{{ f }}</span>
              <span class="pi-file-label">
                {{ conflictPreview.conflictingFiles.includes(f) ? t('pr.intel.conflictLikely') : t('pr.intel.overlap') }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="conflictPreview.cleanFiles.length > 0" class="pi-conflict-detail">
          <div class="pi-subsection-label">{{ t('pr.intel.cleanFilesLabel', conflictPreview.cleanFiles.length) }}</div>
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
      <header class="pi-section-header">
        <span class="pi-section-icon" aria-hidden="true">
          <!-- ruler / scope -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="5" width="12" height="6" rx="1" />
            <path d="M5 5v2M8 5v3M11 5v2" />
          </svg>
        </span>
        <h3 class="pi-section-title">{{ t('pr.intel.scopeTitle') }}</h3>
        <span
          class="pi-badge pi-badge--risk"
          :style="{ background: scope.riskColor + '28', color: scope.riskColor, borderColor: scope.riskColor + '70' }"
        >{{ scope.riskLabel }}</span>
      </header>

      <div class="pi-scope-grid">
        <div class="pi-stat">
          <span class="pi-stat-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z" />
              <path d="M10 2v3h3" />
            </svg>
          </span>
          <span class="pi-stat-label">{{ t('pr.intel.scopeFiles') }}</span>
          <span class="pi-stat-value">{{ scope.changedFiles }}</span>
        </div>
        <div class="pi-stat">
          <span class="pi-stat-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </span>
          <span class="pi-stat-label">{{ t('pr.intel.scopeLines') }}</span>
          <span class="pi-stat-value pi-stat-diff">
            <span class="pi-add">+{{ scope.additions }}</span>
            <span class="pi-del">−{{ scope.deletions }}</span>
          </span>
        </div>
        <div v-if="scope.pct !== null" class="pi-stat">
          <span class="pi-stat-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4v4l2.5 1.5" />
            </svg>
          </span>
          <span class="pi-stat-label">{{ t('pr.intel.scopePct') }}</span>
          <span class="pi-stat-value">{{ scope.pct }}%</span>
        </div>
        <div class="pi-stat">
          <span class="pi-stat-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 4h12M2 8h12M2 12h8" />
            </svg>
          </span>
          <span class="pi-stat-label">{{ t('pr.intel.scopeTotal') }}</span>
          <span class="pi-stat-value">{{ scope.totalLines }}</span>
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
      <p class="pi-risk-hint">
        <span v-if="scope.risk === 'low'">{{ t('pr.intel.hintLow') }}</span>
        <span v-else-if="scope.risk === 'medium'">{{ t('pr.intel.hintMedium') }}</span>
        <span v-else-if="scope.risk === 'high'">{{ t('pr.intel.hintHigh') }}</span>
        <span v-else>{{ t('pr.intel.hintCritical') }}</span>
      </p>
    </section>

    <!-- ── Hotspot Analysis ───────────────────────────────── -->
    <section class="pi-section">
      <header class="pi-section-header">
        <span class="pi-section-icon" aria-hidden="true">
          <!-- flame -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
            <path d="M8 1.5c.5 2 2.5 3 2.5 5 0 .7-.3 1.3-.8 1.8 1.5 0 3 1.2 3 3.2C12.7 13.5 10.5 15 8 15s-4.7-1.5-4.7-3.5c0-1.7 1.2-2.5 2-3.5.7-.9.7-2 .4-3 1.3.5 2 1.5 2 2.5.3-2 1-3.5.3-6z" />
          </svg>
        </span>
        <h3 class="pi-section-title">{{ t('pr.intel.hotspotTitle') }}</h3>
        <span class="pi-badge pi-badge--info">{{ t('pr.intel.historyBadge') }}</span>
        <div class="pi-spacer" />
        <span v-if="hotspotsLoading" class="pi-loading">
          <span class="pi-dot-spinner" aria-hidden="true"></span>
          {{ t('pr.intel.loading') }}
        </span>
      </header>

      <div v-if="topHotspots.length === 0 && !hotspotsLoading" class="pi-empty">
        {{ t('pr.intel.noHotspots') }}
      </div>

      <div v-if="topHotspots.length > 0" class="pi-hotspot-list">
        <div
          v-for="h in topHotspots"
          :key="h.path"
          class="pi-hotspot-row"
          :class="`pi-hotspot-row--${hotspotTier(h.score)}`"
        >
          <span class="pi-hotspot-icon" aria-hidden="true">
            <svg
              v-if="hotspotTier(h.score) === 'high'"
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            >
              <path d="M8 1.5c.5 2 2.5 3 2.5 5 0 .7-.3 1.3-.8 1.8 1.5 0 3 1.2 3 3.2C12.7 13.5 10.5 15 8 15s-4.7-1.5-4.7-3.5c0-1.7 1.2-2.5 2-3.5.7-.9.7-2 .4-3 1.3.5 2 1.5 2 2.5.3-2 1-3.5.3-6z" />
            </svg>
            <svg
              v-else-if="hotspotTier(h.score) === 'medium'"
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 2L3 9h4l-1 5 6-7H8z" />
            </svg>
            <svg
              v-else
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z" />
              <path d="M10 2v3h3" />
            </svg>
          </span>
          <span class="pi-hotspot-name mono">{{ h.path.split('/').pop() }}</span>
          <div class="pi-hotspot-bar-track">
            <div class="pi-hotspot-bar-fill" :style="{ width: Math.min(100, h.score) + '%' }" />
          </div>
          <span class="pi-hotspot-count">{{ t('pr.intel.mergeCount', h.mergeCount) }}</span>
        </div>
      </div>

      <div v-if="hotspots.length > 0 && topHotspots.length === 0" class="pi-empty">
        {{ t('pr.intel.hotspotAllClean') }}
      </div>
    </section>

    <!-- ── AI Review Suggestions ──────────────────────────── -->
    <section class="pi-section">
      <header class="pi-section-header">
        <span class="pi-section-icon pi-section-icon--ai" aria-hidden="true">
          <!-- sparkle cluster (matches tab icon) -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6.5 2l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" />
            <path d="M11.5 9l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
          </svg>
        </span>
        <h3 class="pi-section-title">{{ t('pr.intel.suggestionsTitle') }}</h3>
        <span class="pi-badge pi-badge--ai">{{ t('pr.intel.staticBadge') }}</span>
      </header>

      <div v-if="aiFlags.length === 0" class="pi-empty">
        {{ t('pr.intel.noAnomalies') }}
      </div>

      <div v-else class="pi-ai-list">
        <div
          v-for="(flag, i) in aiFlags"
          :key="i"
          class="pi-ai-row"
          :class="`pi-ai-row--${flag.severity}`"
        >
          <span class="pi-ai-icon" aria-hidden="true">
            <!-- siren for error, triangle-bang for warn, info-circle for info -->
            <svg
              v-if="flag.severity === 'error'"
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v4M8 11v.01" />
            </svg>
            <svg
              v-else-if="flag.severity === 'warn'"
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M8 2l6.5 11h-13z" />
              <path d="M8 7v3M8 12v.01" />
            </svg>
            <svg
              v-else
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7v4M8 5v.01" />
            </svg>
          </span>
          <div class="pi-ai-content">
            <span class="pi-ai-file mono">{{ flag.file.split('/').pop() }}</span>
            <span class="pi-ai-reason">{{ flag.reason }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── AI Pre-Review Findings (C4, v3.6.0) ──────────────── -->
    <section class="pi-section">
      <header class="pi-section-header">
        <span class="pi-section-icon pi-section-icon--ai" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6.5 2l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" />
            <path d="M11.5 9l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
          </svg>
        </span>
        <h3 class="pi-section-title">{{ t('pr.preReview.title') }}</h3>
        <span v-if="preReviewRunning" class="pi-badge pi-badge--ai">
          {{ t('pr.preReview.progress', preReviewProgress.done, preReviewProgress.total) }}
        </span>
      </header>

      <div v-if="preReviewRunning && preReviewFindings.length === 0" class="pi-empty">
        {{ t('pr.preReview.running') }}
      </div>
      <div v-else-if="preReviewFindings.length === 0" class="pi-empty">
        {{ t('pr.preReview.empty') }}
      </div>

      <div v-else class="pi-ai-list">
        <div
          v-for="f in preReviewFindings"
          :key="f.id"
          class="pi-ai-row pi-finding-row"
          :class="`pi-ai-row--${findingRowSeverity(f.severity)}`"
        >
          <button type="button" class="pi-finding-jump" @click="emit('jump-to-finding', f.path, f.line)">
            <div class="pi-ai-content">
              <span class="pi-ai-file mono">{{ f.path.split('/').pop() }}:{{ f.line }}</span>
              <span class="pi-ai-reason">{{ f.title }}</span>
            </div>
          </button>
          <span class="pi-finding-confidence">{{ f.confidence }}%</span>
          <button
            type="button"
            class="pi-finding-dismiss"
            :title="t('pr.preReview.dismiss')"
            @click="emit('dismiss-finding', f.id)"
          >✕</button>
        </div>
      </div>
    </section>

    <!-- ── File Review History ─────────────────────────────── -->
    <section class="pi-section">
      <header class="pi-section-header">
        <span class="pi-section-icon" aria-hidden="true">
          <!-- clock / history -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.5V8l2.5 1.5" />
          </svg>
        </span>
        <h3 class="pi-section-title">{{ t('pr.intel.historyTitle') }}</h3>
        <div class="pi-spacer" />
        <span v-if="fileHistoryLoading" class="pi-loading">
          <span class="pi-dot-spinner" aria-hidden="true"></span>
          {{ t('pr.intel.loading') }}
        </span>
      </header>

      <div v-if="Object.keys(fileHistory).length === 0 && !fileHistoryLoading" class="pi-empty">
        {{ t('pr.intel.noHistory') }}
      </div>

      <div v-else class="pi-history-list">
        <template v-for="(hist, filePath) in fileHistory" :key="filePath">
          <div v-if="hist.reviewCommentCount > 0" class="pi-history-row">
            <div class="pi-history-file mono">{{ String(filePath).split('/').pop() }}</div>
            <div class="pi-history-meta">
              <span class="pi-history-count">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 8c0 3-3 5.5-6 5.5-.7 0-1.4-.1-2-.3L3 14l.7-2.8A5.5 5.5 0 0 1 2 8c0-3 3-5.5 6-5.5S14 5 14 8z" />
                </svg>
                {{ hist.reviewCommentCount }}
              </span>
              <span v-if="hist.reviewers.length" class="pi-history-reviewers">
                {{ t('pr.intel.historyBy', hist.reviewers.slice(0, 3).join(', ') + (hist.reviewers.length > 3 ? ` +${hist.reviewers.length - 3}` : '')) }}
              </span>
            </div>
            <div v-if="hist.lastComment" class="pi-history-last">
              {{ t('pr.intel.lastLabel') }} <em>{{ hist.lastComment.body }}…</em>
              <span v-if="hist.lastComment.pr_number" class="pi-history-pr">PR #{{ hist.lastComment.pr_number }}</span>
            </div>
          </div>
        </template>
        <div
          v-if="Object.values(fileHistory).every((h) => h.reviewCommentCount === 0)"
          class="pi-empty"
        >
          {{ t('pr.intel.noCommentedBefore') }}
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
/* ─── Shell ──────────────────────────────────────────────── */
.pi-root {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
  height: 100%;
  background: var(--color-bg);
}

/* ─── Section frame ──────────────────────────────────────── */
.pi-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--color-border);
}
.pi-section:last-child { border-bottom: none; }

.pi-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.pi-section-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}
.pi-section-icon--ai {
  background: linear-gradient(135deg, var(--color-accent-soft), rgba(217, 70, 239, 0.18));
}

.pi-section-title {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  letter-spacing: -0.005em;
}

.pi-spacer { flex: 1; }

/* ─── Badges ─────────────────────────────────────────────── */
.pi-badge {
  display: inline-flex;
  align-items: center;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  border: 1px solid;
  line-height: 1.5;
  white-space: nowrap;
}
.pi-badge--info {
  background: var(--color-info-soft);
  color: var(--color-info);
  border-color: transparent;
}
.pi-badge--ai {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: transparent;
}

/* ─── Inline helpers ─────────────────────────────────────── */
.pi-empty {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-style: italic;
  padding: var(--space-2) 0;
}

.pi-loading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: var(--font-weight-medium);
}

.pi-dot-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: pi-spin 0.8s linear infinite;
}
@keyframes pi-spin { to { transform: rotate(360deg); } }

.pi-action-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: inherit;
  background: var(--color-accent);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  color: var(--color-accent-text);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  line-height: 1.4;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  transition: background var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
}
.pi-action-btn:hover {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.22), 0 0 0 3px var(--color-accent-soft);
  transform: translateY(-1px);
}
.pi-action-btn:active {
  transform: translateY(0);
  box-shadow: none;
}

.pi-msg--error {
  font-size: var(--font-size-sm);
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
}

.pi-subsection-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-bottom: var(--space-3);
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ─── Conflict banner ───────────────────────────────────── */
.pi-banner {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-snug);
  border: 1px solid;
  align-self: flex-start;
}
.pi-banner-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pi-banner--ok {
  background: var(--color-success-soft);
  border-color: var(--color-success);
  color: var(--color-success);
}
.pi-banner--bad {
  background: var(--color-danger-soft);
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.pi-conflict-detail { display: flex; flex-direction: column; }

/* ─── File list rows (conflict / overlap) ────────────────── */
.pi-file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pi-file-list--compact {
  flex-direction: row;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.pi-file-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  padding-left: calc(var(--space-4) + 1px);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-text-muted);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.pi-file-row:hover {
  background: var(--color-bg-tertiary);
}
.pi-file-row--conflict {
  border-left-color: var(--color-danger);
}
.pi-file-row--conflict .pi-file-icon { color: var(--color-danger); }
.pi-file-row--overlap {
  border-left-color: var(--color-warning);
}
.pi-file-row--overlap .pi-file-icon { color: var(--color-warning); }

.pi-file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pi-file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-size: var(--font-size-xs);
}
.pi-file-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
  flex-shrink: 0;
}

.pi-chip {
  display: inline-flex;
  align-items: center;
  font-size: var(--font-size-xs);
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  white-space: nowrap;
  font-family: var(--font-mono);
}
.pi-chip--clean {
  color: var(--color-success);
  border-color: var(--color-success);
  background: var(--color-success-soft);
}
.pi-chip--more {
  color: var(--color-accent);
  border-color: transparent;
  background: var(--color-accent-soft);
  font-family: inherit;
  font-weight: var(--font-weight-semibold);
}

/* ─── Scope (stat-cards + risk bar) ──────────────────────── */
.pi-scope-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-3);
}

.pi-stat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast);
}
.pi-stat::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 100% at 100% 0%, var(--color-accent-soft), transparent 50%);
  opacity: 0;
  transition: opacity var(--transition-base);
  pointer-events: none;
}
.pi-stat:hover {
  border-color: var(--color-border-strong);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
.pi-stat:hover::before { opacity: 0.35; }

.pi-stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.pi-stat-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.pi-stat-value {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--color-text);
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-3);
}
.pi-stat-diff { font-family: var(--font-mono); font-size: var(--font-size-md); }
.pi-add { color: var(--color-success); }
.pi-del { color: var(--color-danger); }

.pi-risk-bar-track {
  height: 6px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.pi-risk-bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width 0.4s ease, background 0.3s ease;
}
.pi-risk-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-style: italic;
}

/* ─── Hotspots ──────────────────────────────────────────── */
.pi-hotspot-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pi-hotspot-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  padding-left: calc(var(--space-4) + 1px);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  font-size: var(--font-size-xs);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.pi-hotspot-row:hover { background: var(--color-bg-tertiary); }

.pi-hotspot-row--high { border-left-color: var(--color-danger); }
.pi-hotspot-row--high .pi-hotspot-icon { color: var(--color-danger); }
.pi-hotspot-row--high .pi-hotspot-bar-fill { background: var(--color-danger); }

.pi-hotspot-row--medium { border-left-color: var(--color-warning); }
.pi-hotspot-row--medium .pi-hotspot-icon { color: var(--color-warning); }
.pi-hotspot-row--medium .pi-hotspot-bar-fill { background: var(--color-warning); }

.pi-hotspot-row--low { border-left-color: var(--color-border-strong); }
.pi-hotspot-row--low .pi-hotspot-icon { color: var(--color-text-muted); }
.pi-hotspot-row--low .pi-hotspot-bar-fill { background: var(--color-text-muted); }

.pi-hotspot-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pi-hotspot-name {
  width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  flex-shrink: 0;
  font-weight: var(--font-weight-medium);
}
.pi-hotspot-bar-track {
  flex: 1;
  height: 5px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-pill);
  overflow: hidden;
  min-width: 60px;
}
.pi-hotspot-bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
}
.pi-hotspot-count {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  width: 70px;
  text-align: right;
  flex-shrink: 0;
}

/* ─── AI flags ───────────────────────────────────────────── */
.pi-ai-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pi-ai-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  padding-left: calc(var(--space-4) + 1px);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  font-size: var(--font-size-sm);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.pi-ai-row:hover { background: var(--color-bg-tertiary); }

.pi-ai-row--error { border-left-color: var(--color-danger); }
.pi-ai-row--error .pi-ai-icon { color: var(--color-danger); }
.pi-ai-row--warn { border-left-color: var(--color-warning); }
.pi-ai-row--warn .pi-ai-icon { color: var(--color-warning); }
.pi-ai-row--info { border-left-color: var(--color-info); }
.pi-ai-row--info .pi-ai-icon { color: var(--color-info); }

.pi-ai-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}
.pi-ai-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pi-ai-file {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  font-size: var(--font-size-xs);
}
.pi-ai-reason {
  color: var(--color-text);
  line-height: var(--line-height-snug);
  font-size: var(--font-size-sm);
}

/* ─── AI pre-review findings (C4, v3.6.0) ─────────────────── */
.pi-finding-row {
  align-items: center;
}
.pi-finding-jump {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.pi-finding-confidence {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.pi-finding-dismiss {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  width: 20px;
  height: 20px;
  line-height: 1;
  cursor: pointer;
}
.pi-finding-dismiss:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

/* ─── File history ──────────────────────────────────────── */
.pi-history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pi-history-row {
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.pi-history-row:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-tertiary);
}
.pi-history-file {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  margin-bottom: 2px;
  font-size: var(--font-size-xs);
}
.pi-history-meta {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.pi-history-count {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-accent);
  font-weight: var(--font-weight-semibold);
}
.pi-history-reviewers {
  font-size: var(--font-size-xs);
}
.pi-history-last {
  margin-top: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pi-history-pr {
  margin-left: var(--space-3);
  color: var(--color-accent);
  font-weight: var(--font-weight-semibold);
}

.mono { font-family: var(--font-mono); }

@media (prefers-reduced-motion: reduce) {
  .pi-stat,
  .pi-action-btn,
  .pi-risk-bar-fill,
  .pi-file-row,
  .pi-hotspot-row,
  .pi-ai-row,
  .pi-history-row {
    transition: none;
  }
  .pi-stat:hover,
  .pi-action-btn:hover {
    transform: none;
  }
  .pi-dot-spinner { animation: none; }
}
</style>
