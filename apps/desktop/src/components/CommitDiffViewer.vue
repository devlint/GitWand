<script setup lang="ts">
import { computed } from "vue";
import type { GitDiff } from "../utils/backend";

const props = defineProps<{
  diffs: GitDiff[];
  commitHash: string | null;
}>();

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function diffStats(diff: GitDiff) {
  let adds = 0;
  let dels = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") adds++;
      else if (line.type === "delete") dels++;
    }
  }
  return { adds, dels };
}

const totalStats = computed(() => {
  let adds = 0;
  let dels = 0;
  for (const diff of props.diffs) {
    const s = diffStats(diff);
    adds += s.adds;
    dels += s.dels;
  }
  return { adds, dels, files: props.diffs.length };
});
</script>

<template>
  <div class="commit-diff-viewer">
    <!-- Summary header -->
    <div class="cdv-header" v-if="commitHash">
      <span class="cdv-hash mono">{{ commitHash?.substring(0, 8) }}</span>
      <span class="cdv-summary">
        {{ totalStats.files }} {{ totalStats.files === 1 ? 'fichier' : 'fichiers' }}
      </span>
      <span class="cdv-stat cdv-stat--add" v-if="totalStats.adds > 0">+{{ totalStats.adds }}</span>
      <span class="cdv-stat cdv-stat--del" v-if="totalStats.dels > 0">-{{ totalStats.dels }}</span>
    </div>

    <!-- File diffs -->
    <div class="cdv-content" v-if="diffs.length > 0">
      <div
        v-for="(fileDiff, fileIdx) in diffs"
        :key="fileIdx"
        class="cdv-file"
      >
        <div class="cdv-file-header">
          <span class="cdv-file-name mono">{{ fileName(fileDiff.path) }}</span>
          <span class="cdv-file-path muted">{{ fileDiff.path }}</span>
          <div class="cdv-file-stats">
            <span class="cdv-stat cdv-stat--add" v-if="diffStats(fileDiff).adds > 0">
              +{{ diffStats(fileDiff).adds }}
            </span>
            <span class="cdv-stat cdv-stat--del" v-if="diffStats(fileDiff).dels > 0">
              -{{ diffStats(fileDiff).dels }}
            </span>
          </div>
        </div>

        <div
          v-for="(hunk, hunkIdx) in fileDiff.hunks"
          :key="hunkIdx"
          class="cdv-hunk"
        >
          <div class="cdv-hunk-header mono">{{ hunk.header }}</div>
          <table class="cdv-table">
            <tbody>
              <tr
                v-for="(line, lineIdx) in hunk.lines"
                :key="lineIdx"
                class="cdv-line"
                :class="`cdv-line--${line.type}`"
              >
                <td class="cdv-line-no mono">{{ line.oldLineNo ?? '' }}</td>
                <td class="cdv-line-no mono">{{ line.newLineNo ?? '' }}</td>
                <td class="cdv-line-marker mono">
                  {{ line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ' }}
                </td>
                <td class="cdv-line-content mono">
                  <span>{{ line.content || '\u00a0' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div class="cdv-empty" v-else-if="commitHash">
      <span class="muted">Pas de diff pour ce commit</span>
    </div>
    <div class="cdv-empty" v-else>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" stroke="var(--color-text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>
      </svg>
      <span class="muted">S&eacute;lectionnez un commit pour voir les changements</span>
    </div>
  </div>
</template>

<style scoped>
.commit-diff-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.cdv-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.cdv-hash {
  font-size: 12px;
  color: var(--color-accent);
  font-weight: 600;
}

.cdv-summary {
  font-size: 12px;
  color: var(--color-text-muted);
}

.cdv-stat {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.cdv-stat--add {
  color: var(--color-success);
}

.cdv-stat--del {
  color: var(--color-danger);
}

.cdv-content {
  flex: 1;
  overflow: auto;
}

.cdv-file {
  border-bottom: 2px solid var(--color-border);
}

.cdv-file:last-child {
  border-bottom: none;
}

.cdv-file-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 2;
}

.cdv-file-name {
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.cdv-file-path {
  font-size: 11px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cdv-file-stats {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.cdv-hunk-header {
  padding: 4px 16px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
}

.cdv-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.cdv-line {
  line-height: 1.5;
}

.cdv-line--context { background: var(--color-bg); }
.cdv-line--add { background: rgba(34, 197, 94, 0.1); }
.cdv-line--delete { background: rgba(239, 68, 68, 0.1); }

.cdv-line-no {
  width: 44px;
  min-width: 44px;
  padding: 0 6px;
  text-align: right;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--color-border);
}

.cdv-line-marker {
  width: 18px;
  min-width: 18px;
  padding: 0 3px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
  user-select: none;
}

.cdv-line--add .cdv-line-marker { color: var(--color-success); font-weight: 700; }
.cdv-line--delete .cdv-line-marker { color: var(--color-danger); font-weight: 700; }

.cdv-line-content {
  padding: 0 10px;
  font-size: 12px;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cdv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
}
</style>
