<script setup lang="ts">
import { computed } from "vue";
import type { GitDiff, DiffHunk, DiffLine } from "../utils/backend";

const props = defineProps<{
  diff: GitDiff | null;
  filePath: string | null;
}>();

const hasContent = computed(() => {
  return props.diff && props.diff.hunks.length > 0;
});

const totalStats = computed(() => {
  if (!props.diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const hunk of props.diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      else if (line.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
});

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}
</script>

<template>
  <div class="diff-viewer">
    <!-- File header -->
    <div class="diff-header" v-if="filePath">
      <div class="diff-file-info">
        <span class="diff-file-name mono">{{ fileName(filePath) }}</span>
        <span class="diff-file-path muted">{{ filePath }}</span>
      </div>
      <div class="diff-stats" v-if="hasContent">
        <span class="diff-stat diff-stat--add" v-if="totalStats.additions > 0">
          +{{ totalStats.additions }}
        </span>
        <span class="diff-stat diff-stat--del" v-if="totalStats.deletions > 0">
          -{{ totalStats.deletions }}
        </span>
      </div>
    </div>

    <!-- Diff content -->
    <div class="diff-content" v-if="hasContent">
      <div
        v-for="(hunk, hunkIdx) in diff!.hunks"
        :key="hunkIdx"
        class="diff-hunk"
      >
        <div class="hunk-header mono">
          {{ hunk.header }}
        </div>

        <table class="diff-table">
          <tbody>
            <tr
              v-for="(line, lineIdx) in hunk.lines"
              :key="lineIdx"
              class="diff-line"
              :class="`diff-line--${line.type}`"
            >
              <td class="line-no mono">
                {{ line.oldLineNo ?? '' }}
              </td>
              <td class="line-no mono">
                {{ line.newLineNo ?? '' }}
              </td>
              <td class="line-marker mono">
                {{ line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ' }}
              </td>
              <td class="line-content mono">
                <span>{{ line.content || '\u00a0' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Empty / no diff -->
    <div class="diff-empty" v-else-if="filePath">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="var(--color-text-muted)" stroke-width="1.5" opacity="0.4"/>
        <polyline points="14,2 14,8 20,8" stroke="var(--color-text-muted)" stroke-width="1.5" opacity="0.4"/>
      </svg>
      <span class="diff-empty-text">Pas de diff disponible pour ce fichier</span>
      <span class="diff-empty-hint muted">Fichier nouveau ou binaire</span>
    </div>

    <!-- No file selected -->
    <div class="diff-empty" v-else>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" stroke="var(--color-text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>
      </svg>
      <span class="diff-empty-text">S&eacute;lectionnez un fichier pour voir le diff</span>
    </div>
  </div>
</template>

<style scoped>
.diff-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.diff-file-info {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.diff-file-name {
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.diff-file-path {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-stats {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.diff-stat {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.diff-stat--add {
  color: var(--color-success);
}

.diff-stat--del {
  color: var(--color-danger);
}

.diff-content {
  flex: 1;
  overflow: auto;
}

.diff-hunk {
  margin-bottom: 2px;
}

.hunk-header {
  padding: 6px 16px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.diff-line {
  line-height: 1.5;
}

.diff-line--context {
  background: var(--color-bg);
}

.diff-line--add {
  background: rgba(34, 197, 94, 0.1);
}

.diff-line--delete {
  background: rgba(239, 68, 68, 0.1);
}

.line-no {
  width: 48px;
  min-width: 48px;
  padding: 0 8px;
  text-align: right;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.5;
  user-select: none;
  vertical-align: top;
  border-right: 1px solid var(--color-border);
}

.diff-line--add .line-no:nth-child(2) {
  color: var(--color-success);
  opacity: 0.7;
}

.diff-line--delete .line-no:first-child {
  color: var(--color-danger);
  opacity: 0.7;
}

.line-marker {
  width: 20px;
  min-width: 20px;
  padding: 0 4px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
  user-select: none;
  vertical-align: top;
}

.diff-line--add .line-marker {
  color: var(--color-success);
  font-weight: 700;
}

.diff-line--delete .line-marker {
  color: var(--color-danger);
  font-weight: 700;
}

.line-content {
  padding: 0 12px;
  font-size: 12px;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-line--add .line-content {
  color: var(--color-text);
}

.diff-line--delete .line-content {
  color: var(--color-text);
  opacity: 0.8;
}

.diff-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
}

.diff-empty-text {
  font-size: 14px;
  color: var(--color-text-muted);
}

.diff-empty-hint {
  font-size: 12px;
}
</style>
