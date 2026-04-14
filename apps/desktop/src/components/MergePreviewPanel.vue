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

    <!-- Global badge -->
    <div class="preview-header">
      <span
        class="preview-badge"
        :class="badgeClass"
      >{{ badgeLabel }}</span>
      <span class="preview-branch">← {{ summary.sourceBranch }}</span>
      <button class="preview-close" @click="$emit('close')">✕</button>
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
        class="preview-file"
        :class="`preview-file--${f.status}`"
      >
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
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../composables/useI18n.js";
import type { MergePreviewSummary, PreviewFileResult, PreviewFileStatus } from "../composables/useMergePreview.js";

const props = defineProps<{
  loading: boolean;
  error: string | null;
  summary: MergePreviewSummary | null;
  conflictingFiles: PreviewFileResult[];
}>();

defineEmits<{ close: [] }>();

const { t } = useI18n();

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
.preview-panel {
  background: var(--color-surface-2, #1e1e2e);
  border: 1px solid var(--color-border, #313244);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--color-text, #cdd6f4);
  min-width: 240px;
  max-width: 340px;
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
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-subtext, #6c7086);
  font-size: 11px;
}

.preview-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-subtext, #6c7086);
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
}
.preview-close:hover { color: var(--color-text, #cdd6f4); }

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
  background: var(--color-surface-1, #181825);
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
</style>
