<template>
  <!-- ─── Loading ─────────────────────────────────────── -->
  <div v-if="loading" class="preview-panel preview-panel--loading">
    <span class="preview-icon preview-icon--spin">⟳</span>
    <span class="preview-label">{{ t('mergePreview.analyzing') }}</span>
  </div>

  <!-- ─── Error ───────────────────────────────────────── -->
  <div v-else-if="error" class="preview-panel preview-panel--error">
    <span class="preview-icon">✕</span>
    <span class="preview-label">{{ error }}</span>
  </div>

  <!-- ─── Summary ─────────────────────────────────────── -->
  <div v-else-if="summary" class="preview-panel">

    <!-- Operation selector (merge / rebase / cherry-pick) -->
    <div class="preview-ops" role="tablist" :aria-label="t('mergePreview.operationLabel')">
      <button
        v-for="op in OPERATIONS"
        :key="op"
        type="button"
        role="tab"
        class="preview-op"
        :class="{ 'preview-op--active': (operation ?? 'merge') === op }"
        :aria-selected="(operation ?? 'merge') === op"
        @click="emit('update:operation', op)"
      >{{ t(`mergePreview.op.${op}`) }}</button>
    </div>

    <!-- Global badge -->
    <div class="preview-header">
      <span
        class="preview-badge"
        :class="badgeClass"
      >{{ badgeLabel }}</span>
      <span
        v-if="riskLevel"
        class="preview-risk-badge"
        :class="riskClass"
        :title="t('mergePreview.riskLabel')"
      >{{ riskLabel }}</span>
      <span class="preview-branch">← {{ summary.sourceBranch }}</span>
      <button
        v-if="ai.isAvailable.value && summary.files.length > 0"
        class="btn btn--ai preview-ai"
        :disabled="isMergeRiskAssessing"
        :title="t('mergePreview.aiRiskHint')"
        @click="requestMergeRisk"
      >
        <span v-if="isMergeRiskAssessing">… {{ t('mergePreview.aiRiskAnalyzing') }}</span>
        <span v-else class="preview-ai-label">
          <AiSparkle :size="14" />
          {{ t('mergePreview.aiRisk') }}
        </span>
      </button>
      <button class="preview-close" @click="$emit('close')">✕</button>
    </div>

    <!-- AI risk assessment panel -->
    <div v-if="riskOpen" class="preview-risk" role="status" aria-live="polite">
      <div class="preview-risk-body">
        <span v-if="mergeRiskError" class="preview-risk-error">{{ mergeRiskError }}</span>
        <span v-else-if="isMergeRiskAssessing && !riskText">{{ t('mergePreview.aiRiskAnalyzing') }}</span>
        <span v-else>{{ riskText }}</span>
      </div>
      <button v-if="!isMergeRiskAssessing" class="preview-risk-close" @click="dismissRisk">✕</button>
    </div>

    <!-- Stats row -->
    <div class="preview-stats">
      <span v-if="summary.conflictingFiles > 0" class="stat stat--conflict">
        {{ summary.conflictingFiles }} {{ t('mergePreview.conflicting') }}
      </span>
      <span v-if="summary.autoResolvableFiles > 0" class="stat stat--auto">
        {{ summary.autoResolvableFiles }} {{ t('mergePreview.autoResolved') }}
      </span>
      <span v-if="summary.manualFiles > 0" class="stat stat--manual">
        {{ summary.manualFiles }} {{ t('mergePreview.manual') }}
      </span>
      <span v-if="summary.cleanFiles > 0" class="stat stat--clean">
        {{ summary.cleanFiles }} {{ t('mergePreview.clean') }}
      </span>
    </div>

    <!-- Per-file list (conflicting files only) -->
    <div v-if="conflictingFiles.length > 0" class="preview-files">
      <div
        v-for="f in conflictingFiles"
        :key="f.filePath"
        class="preview-file-group"
      >
        <button
          type="button"
          class="preview-file"
          :class="[`preview-file--${f.status}`, { 'preview-file--expandable': f.hunks.length > 0 }]"
          :aria-expanded="expanded.has(f.filePath)"
          @click="f.hunks.length > 0 && toggleExpand(f.filePath)"
        >
          <span v-if="f.hunks.length > 0" class="pf-chevron">{{ expanded.has(f.filePath) ? '▾' : '▸' }}</span>
          <span class="pf-icon">{{ statusIcon(f.status) }}</span>
          <span class="pf-path" :title="f.filePath">{{ basename(f.filePath) }}</span>
          <span class="pf-detail">
            <template v-if="f.status === 'auto-resolved'">
              {{ f.totalConflicts }} {{ t('mergePreview.conflictsAutoResolved') }}
            </template>
            <template v-else-if="f.status === 'partial'">
              {{ f.autoResolved }}/{{ f.totalConflicts }} {{ t('mergePreview.partial') }}
            </template>
            <template v-else-if="f.status === 'add-delete'">
              {{ t('mergePreview.addDelete') }}
            </template>
            <template v-else>
              {{ f.totalConflicts }} {{ t('mergePreview.conflictsManual') }}
            </template>
          </span>
        </button>

        <!-- Hunk-by-hunk predicted conflicts -->
        <ul v-if="expanded.has(f.filePath) && f.hunks.length > 0" class="preview-hunks">
          <li
            v-for="(h, i) in f.hunks"
            :key="i"
            class="preview-hunk"
            :class="hunkClass(h)"
            :title="`${h.confidenceScore}% (${h.confidenceLabel}) — ${h.reason}`"
          >
            <!-- A bar, not a number: the score is only actionable on the rows
                 the bar is holding back, and those show it below. -->
            <span
              class="ph-confidence"
              :class="`ph-confidence--${h.confidenceLabel}`"
              aria-hidden="true"
            ></span>
            <span class="ph-icon">{{ hunkIcon(h) }}</span>
            <span class="ph-line">{{ t('mergePreview.hunkLine') }} {{ h.startLine }}</span>
            <span class="ph-type">{{ h.type }}</span>
            <span class="ph-status">
              <template v-if="isHeldBack(h)">
                {{ t('mergePreview.hunkHeldBack', String(h.confidenceScore)) }}
              </template>
              <template v-else>
                {{ h.autoResolved ? t('mergePreview.hunkAuto') : t('mergePreview.hunkManual') }}
              </template>
            </span>
          </li>
        </ul>
      </div>
    </div>

    <!-- ─── Confidence bar (v3.11.0) ─────────────────────── -->
    <div v-if="summary.conflictingFiles > 0" class="preview-bar">
      <div class="preview-bar__head">
        <span class="preview-bar__label">{{ t('mergePreview.thresholdLabel') }}</span>
        <!-- Five stops, not a free slider: scores cluster around a handful of
             dimension combinations, so ~95 continuous positions would do
             nothing and invite false precision. -->
        <div class="preview-bar__stops" role="group" :aria-label="t('mergePreview.thresholdLabel')">
          <button
            v-for="stop in THRESHOLD_STOPS"
            :key="stop"
            type="button"
            class="preview-bar__stop"
            :class="{ 'preview-bar__stop--active': threshold === stop }"
            :aria-pressed="threshold === stop"
            @click="emit('update:threshold', stop)"
          >{{ stop === 0 ? t('mergePreview.thresholdOff') : `${stop}%` }}</button>
        </div>
      </div>
      <p class="preview-bar__summary">
        {{ t('mergePreview.thresholdSummary',
             String(estimatedAutoResolutions),
             String(heldByThreshold),
             String(manualHunks)) }}
      </p>
    </div>

    <!-- ─── Apply from preview (v3.11.0) ─────────────────── -->
    <div v-if="summary.conflictingFiles > 0" class="preview-apply">
      <button
        type="button"
        class="btn btn--primary preview-apply__btn"
        :disabled="props.applying"
        @click="emit('apply')"
      >
        <span v-if="props.applying">… {{ t('mergePreview.applying') }}</span>
        <span v-else>{{ t('mergePreview.applyAndMerge') }}</span>
      </button>
      <!-- "Estimated" is load-bearing: the simulation and the real operation
           use different merge algorithms and can see a different file set, so
           this number is a prediction, not a promise. -->
      <span class="preview-apply__estimate">
        {{ t('mergePreview.applyEstimate',
              String(estimatedAutoResolutions),
              String(estimatedAutoResolutions + heldByThreshold + manualHunks)) }}
      </span>
    </div>

    <MergeApplyReport
      v-if="props.applyOutcome"
      :outcome="props.applyOutcome"
      @dismiss="emit('dismiss-apply')"
      @open-residual="(p) => emit('open-residual', p)"
    />

    <!-- ─── Scratch worktree (v2.20.0) ───────────────────── -->
    <div v-if="summary.conflictingFiles > 0" class="preview-scratch">
      <!-- Error from the last scratch operation -->
      <div v-if="scratchError" class="preview-scratch-error" role="alert">
        {{ scratchError }}
      </div>

      <!-- No active scratch yet: offer to create one. -->
      <button
        v-if="!scratchActive"
        type="button"
        class="btn preview-scratch-btn"
        :disabled="scratchLoading"
        :title="t('scratch.openIsolated')"
        @click="emit('resolve-in-scratch')"
      >
        <span v-if="scratchLoading">… {{ t('mergePreview.analyzing') }}</span>
        <span v-else>{{ t('scratch.create') }}</span>
      </button>

      <!-- An active scratch exists: surface merge-back / discard. -->
      <div v-else class="preview-scratch-active">
        <span class="preview-scratch-path mono" :title="scratchActive.path">
          {{ scratchActive.branch }}
        </span>
        <div class="preview-scratch-actions">
          <button
            type="button"
            class="btn btn--primary preview-scratch-btn"
            :disabled="scratchLoading"
            @click="emit('scratch-merge-back')"
          >{{ t('scratch.mergeBack') }}</button>
          <button
            type="button"
            class="btn preview-scratch-btn"
            :disabled="scratchLoading"
            @click="emit('scratch-discard')"
          >{{ t('scratch.discard') }}</button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "../composables/useI18n.js";
import type { MergePreviewSummary, PreviewFileResult, PreviewFileStatus, PreviewHunk, PreviewOperation, RiskLevel } from "../composables/useMergePreview.js";
import type { ScratchWorktree } from "../utils/backend.js";
import { useAIProvider } from "../composables/useAIProvider.js";
import { useMergeRisk } from "../composables/useMergeRisk.js";
import AiSparkle from "./AiSparkle.vue";
import MergeApplyReport from "./MergeApplyReport.vue";
import type { ApplyOutcome } from "../composables/useApplyFromPreview.js";

const props = defineProps<{
  loading: boolean;
  error: string | null;
  summary: MergePreviewSummary | null;
  conflictingFiles: PreviewFileResult[];
  /** Risk level derived by useMergePreview (low / medium / high). */
  riskLevel?: RiskLevel;
  /** Operation currently simulated (merge / rebase / cherry-pick). */
  operation?: PreviewOperation;
  /** Current/target branch name (what we'd merge INTO). Used by the AI risk assessment. */
  targetBranch?: string;
  /** Active scratch worktree, if one has been created (v2.20.0). */
  scratchActive?: ScratchWorktree | null;
  /** Whether a scratch worktree op (create/merge-back/discard) is in flight. */
  scratchLoading?: boolean;
  /** Error from the last scratch worktree op, surfaced inline. */
  scratchError?: string | null;
  /** v3.11 — current numeric confidence bar, 0 disables it. */
  threshold?: number;
  /** Auto-resolutions surviving the bar. */
  estimatedAutoResolutions?: number;
  /** Auto-resolutions the bar alone is holding back. */
  heldByThreshold?: number;
  /** Hunks the engine refused outright; no bar can rescue these. */
  manualHunks?: number;
  /** v3.11 — an apply is running. */
  applying?: boolean;
  /** v3.11 — what the last apply did, if one has run. */
  applyOutcome?: ApplyOutcome | null;
}>();

const emit = defineEmits<{
  close: [];
  "update:operation": [op: PreviewOperation];
  /** User asked to open an isolated scratch worktree for resolution. */
  "resolve-in-scratch": [];
  /** Bring the scratch resolution back into the main checkout. */
  "scratch-merge-back": [];
  /** Abandon the scratch worktree. */
  "scratch-discard": [];
  /** v3.11 — user moved the confidence bar. */
  "update:threshold": [value: number];
  /** v3.11 — run the operation for real and apply the engine's resolutions. */
  apply: [];
  "dismiss-apply": [];
  "open-residual": [path: string];
}>();

// ─── v3.11 — confidence bar ─────────────────────────────
/** Discrete stops. See the template for why this is not a free slider. */
const THRESHOLD_STOPS = [0, 60, 75, 90, 95] as const;

const threshold = computed(() => props.threshold ?? 0);
const estimatedAutoResolutions = computed(() => props.estimatedAutoResolutions ?? 0);
const heldByThreshold = computed(() => props.heldByThreshold ?? 0);
const manualHunks = computed(() => props.manualHunks ?? 0);

/** Auto-resolvable, but below the current bar. */
function isHeldBack(h: PreviewHunk): boolean {
  return h.autoResolved && h.confidenceScore < threshold.value;
}

function hunkClass(h: PreviewHunk): string {
  if (isHeldBack(h)) return "preview-hunk--held";
  return h.autoResolved ? "preview-hunk--auto" : "preview-hunk--manual";
}

function hunkIcon(h: PreviewHunk): string {
  if (isHeldBack(h)) return "◌";
  return h.autoResolved ? "✓" : "✕";
}

const OPERATIONS: PreviewOperation[] = ["merge", "rebase", "cherry-pick"];

// Per-file hunk-by-hunk expansion state (keyed by file path).
const expanded = ref<Set<string>>(new Set());
function toggleExpand(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

const riskClass = computed(() => `preview-risk-badge--${props.riskLevel ?? "low"}`);
const riskLabel = computed(() => {
  switch (props.riskLevel) {
    case "high":   return t("mergePreview.riskHigh");
    case "medium": return t("mergePreview.riskMedium");
    default:        return t("mergePreview.riskLow");
  }
});

const { t, locale } = useI18n();
const ai = useAIProvider();
const { isAssessing: isMergeRiskAssessing, assess: assessMergeRisk, lastError: mergeRiskError } = useMergeRisk();

// ─── AI risk assessment (Phase 1.3.2) ──────────────────
const riskText = ref<string | null>(null);
const riskOpen = ref(false);

async function requestMergeRisk() {
  if (!props.summary) return;
  riskText.value = null;
  riskOpen.value = true;
  try {
    const text = await assessMergeRisk(
      props.targetBranch ?? "HEAD",
      props.summary,
      { locale: locale.value },
    );
    riskText.value = text;
  } catch {
    // error exposed via mergeRiskError
  }
}

function dismissRisk() {
  riskOpen.value = false;
  riskText.value = null;
}

const badgeClass = computed(() => {
  if (!props.summary) return "";
  if (props.summary.conflictingFiles === 0) return "preview-badge--clean";
  if (props.summary.fullyAutoMergeable) return "preview-badge--auto";
  return "preview-badge--warn";
});

const badgeLabel = computed(() => {
  if (!props.summary) return "";
  if (props.summary.conflictingFiles === 0) return t("mergePreview.noConflicts");
  if (props.summary.fullyAutoMergeable) return t("mergePreview.fullyAuto");
  return t("mergePreview.needsReview");
});

function statusIcon(status: PreviewFileStatus): string {
  switch (status) {
    case "auto-resolved": return "✓";
    case "partial":       return "◑";
    case "manual":        return "✕";
    case "add-delete":    return "⚡";
    default:              return "·";
  }
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
</script>

<style scoped>
.preview-apply {
  border-top: 1px solid var(--color-border);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.preview-apply__btn { flex: 0 0 auto; }
.preview-apply__estimate {
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* ─── v3.11 confidence bar ───────────────────────────── */
.ph-confidence {
  display: inline-block;
  width: 3px;
  align-self: stretch;
  min-height: 12px;
  border-radius: 2px;
  background: var(--color-border);
  flex: 0 0 auto;
}
.ph-confidence--certain,
.ph-confidence--high { background: var(--color-success); }
.ph-confidence--medium { background: var(--color-warning); }
.ph-confidence--low { background: var(--color-danger); }

.preview-hunk--held { opacity: 0.7; }
.preview-hunk--held .ph-status { color: var(--color-warning); }

.preview-bar {
  border-top: 1px solid var(--color-border);
  padding: 10px 12px;
}
.preview-bar__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.preview-bar__label {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.preview-bar__stops {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.preview-bar__stop {
  border: 1px solid var(--color-border);
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  color: var(--color-text-secondary);
}
.preview-bar__stop--active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text);
}
.preview-bar__summary {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* Design tokens only, with no colour fallback.
   `--color-surface-1` / `--color-surface-2` were never defined by either
   theme, so every one of these rules silently fell through to its hard-coded
   Catppuccin fallback: a dark panel, while `--color-text` *is* defined and
   resolves to near-black in light mode. The result was #1e1e2e behind #15151f
   text, so the file names in this panel were invisible in light mode.
   Nothing caught it because the panel had no dev-server route until v3.11 and
   therefore never rendered at all under `pnpm dev:web`. */
.preview-panel {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--color-text);
  /* v3.11: 340px was sized for a stats row and a file list. The confidence
     bar adds five stops on one line, and the apply row a button plus its
     estimate, both of which wrapped into ragged two- and three-line blocks at
     the old cap. */
  min-width: 320px;
  max-width: 460px;
}

.preview-panel--loading,
.preview-panel--error {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-icon--spin {
  display: inline-block;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.preview-panel--error {
  color: var(--color-danger);
}

/* Header */
.preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  /* Wrap rather than squeeze: the row holds two badges, the source branch and
     the AI button, and the branch name is the only flexible item, so without
     this it was the one thing that got ellipsized away to "← …". */
  flex-wrap: wrap;
}

.preview-badge {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-weight: var(--font-semibold);
  font-size: var(--text-xs);
}
.preview-badge--clean  { background: var(--color-success-soft); color: var(--color-success); }
.preview-badge--auto   { background: var(--color-info-soft); color: var(--color-info); }
.preview-badge--warn   { background: var(--color-warning-soft); color: var(--color-warning); }

.preview-branch {
  /* Keep enough room for a realistic branch name before ellipsizing. */
  flex: 1 1 140px;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: 11px;
}

.preview-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
}
.preview-close:hover { color: var(--color-text); }

/* Tight-packing override so the global .btn--ai fits the compact
   preview header (the default 32px min-height is too tall here). */
.preview-ai {
  margin-left: auto;
  min-height: 22px;
  padding: 1px 10px;
  font-size: 11px;
}
.preview-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.preview-risk {
  margin: 8px 0;
  padding: 8px 10px;
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.08));
  border: 1px solid var(--color-accent);
  border-radius: 6px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--color-text);
}

.preview-risk-body {
  flex: 1;
}

.preview-risk-error {
  color: var(--color-danger);
}

.preview-risk-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

.preview-risk-close:hover { color: var(--color-text); }

/* Stats row */
.preview-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.stat {
  font-size: var(--text-xs);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
}
.stat--conflict { background: var(--color-danger-soft); color: var(--color-danger); }
.stat--auto     { background: var(--color-info-soft); color: var(--color-info); }
.stat--manual   { background: var(--color-warning-soft); color: var(--color-warning); }
.stat--clean    { background: var(--color-success-soft); color: var(--color-success); }

/* File list */
.preview-files {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 200px;
  overflow-y: auto;
}

.preview-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
}

.pf-icon {
  font-size: var(--text-xs);
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}
.preview-file--auto-resolved .pf-icon { color: var(--color-success); }
.preview-file--partial .pf-icon        { color: var(--color-info); }
.preview-file--manual .pf-icon         { color: var(--color-danger); }
.preview-file--add-delete .pf-icon     { color: var(--color-warning); }

.pf-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
}

.pf-detail {
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
  white-space: nowrap;
}

/* Operation selector */
.preview-ops {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  padding: 2px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm, 6px);
}
.preview-op {
  flex: 1;
  background: none;
  border: none;
  cursor: pointer;
  padding: 3px 6px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  border-radius: var(--radius-xs, 4px);
  text-transform: capitalize;
}
.preview-op:hover { color: var(--color-text); }
.preview-op--active {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-weight: var(--font-semibold);
}

/* Risk badge */
.preview-risk-badge {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-weight: var(--font-semibold);
  font-size: var(--text-xs);
}
.preview-risk-badge--low    { background: var(--color-success-soft); color: var(--color-success); }
.preview-risk-badge--medium { background: var(--color-warning-soft); color: var(--color-warning); }
.preview-risk-badge--high   { background: var(--color-danger-soft); color: var(--color-danger); }

/* File group + expandable trigger */
.preview-file-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.preview-file {
  width: 100%;
  text-align: left;
  border: none;
  font: inherit;
  color: inherit;
}
.preview-file--expandable { cursor: pointer; }
.pf-chevron {
  font-size: 9px;
  width: 10px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

/* Hunk-by-hunk list */
.preview-hunks {
  list-style: none;
  margin: 0 0 2px 18px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.preview-hunk {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-bg-secondary);
  font-size: var(--text-xs);
}
.preview-hunk--auto .ph-icon   { color: var(--color-success); }
.preview-hunk--manual .ph-icon { color: var(--color-danger); }
.ph-icon { width: 12px; text-align: center; flex-shrink: 0; }
.ph-line { color: var(--color-text-muted); white-space: nowrap; }
.ph-type {
  flex: 1;
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-status { color: var(--color-text-subtle); white-space: nowrap; }

/* Scratch worktree (v2.20.0) */
.preview-scratch {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-scratch-error {
  color: var(--color-danger);
  font-size: var(--text-xs);
  line-height: 1.4;
}
.preview-scratch-btn {
  min-height: 24px;
  padding: 2px 10px;
  font-size: 11px;
}
.preview-scratch-active {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-scratch-path {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-scratch-actions {
  display: flex;
  gap: 6px;
}
</style>
