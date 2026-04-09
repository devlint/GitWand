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
  color: var(--color-red, #f38ba8);
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
  border-radius: 4px;
  font-weight: 600;
  font-size: 11px;
}
.preview-badge--clean  { background: #a6e3a120; color: #a6e3a1; }
.preview-badge--auto   { background: #89b4fa20; color: #89b4fa; }
.preview-badge--warn   { background: #fab38720; color: #fab387; }

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
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
}
.stat--conflict { background: #f38ba820; color: #f38ba8; }
.stat--auto     { background: #89b4fa20; color: #89b4fa; }
.stat--manual   { background: #fab38720; color: #fab387; }
.stat--clean    { background: #a6e3a120; color: #a6e3a1; }

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
  font-size: 11px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}
.preview-file--auto-resolved .pf-icon { color: #a6e3a1; }
.preview-file--partial .pf-icon        { color: #89b4fa; }
.preview-file--manual .pf-icon         { color: #f38ba8; }
.preview-file--add-delete .pf-icon     { color: #fab387; }

.pf-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.pf-detail {
  font-size: 10px;
  color: var(--color-subtext, #6c7086);
  white-space: nowrap;
}
</style>
