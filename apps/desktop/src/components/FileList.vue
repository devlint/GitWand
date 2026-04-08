<script setup lang="ts">
import { computed } from "vue";
import type { ConflictFile } from "../composables/useGitWand";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  files: ConflictFile[];
  selectedFile: ConflictFile | null;
}>();

const emit = defineEmits<{
  select: [path: string];
}>();

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function fileDir(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
}

function statusIcon(file: ConflictFile): string {
  const { totalConflicts, autoResolved } = file.result.stats;
  if (totalConflicts === 0) return "resolved";
  if (autoResolved === totalConflicts) return "auto";
  if (autoResolved > 0) return "partial";
  return "manual";
}

function statusLabel(file: ConflictFile): string {
  const { totalConflicts, autoResolved } = file.result.stats;
  if (totalConflicts === 0) return t('fileList.noConflict');
  if (autoResolved === totalConflicts) return autoResolved > 1 ? t('fileList.autoResolvablePlural', autoResolved) : t('fileList.autoResolvable', autoResolved);
  if (autoResolved > 0) return t('fileList.autoPartial', autoResolved, totalConflicts);
  return totalConflicts > 1 ? t('fileList.conflictCountPlural', totalConflicts) : t('fileList.conflictCount', totalConflicts);
}
</script>

<template>
  <nav class="file-list" :aria-label="t('fileList.title')">
    <div class="file-list-header">
      <span class="file-list-title">{{ t('fileList.title') }}</span>
      <span class="file-list-count">{{ files.length }}</span>
    </div>

    <ul class="file-items" role="listbox" aria-label="Liste des fichiers">
      <li
        v-for="file in files"
        :key="file.path"
        class="file-item"
        :class="{
          'file-item--selected': selectedFile?.path === file.path,
          [`file-item--${statusIcon(file)}`]: true,
        }"
        role="option"
        :aria-selected="selectedFile?.path === file.path"
        tabindex="0"
        @click="emit('select', file.path)"
        @keydown.enter="emit('select', file.path)"
        @keydown.space.prevent="emit('select', file.path)"
      >
        <div class="file-status-dot" :title="statusLabel(file)" aria-hidden="true" />
        <div class="file-info">
          <span class="file-name mono">{{ fileName(file.path) }}</span>
          <span class="file-dir muted">{{ fileDir(file.path) }}</span>
        </div>
        <span class="file-badge" :aria-label="statusLabel(file)">
          {{ file.result.stats.totalConflicts }}
        </span>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.file-list {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.file-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.file-list-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.file-list-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: 1px 6px;
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
}

.file-items {
  list-style: none;
  overflow-y: auto;
  flex: 1;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.12s;
  border-left: 3px solid transparent;
}

.file-item:hover {
  background: var(--color-bg-tertiary);
}

.file-item--selected {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

.file-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.file-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.file-item--resolved .file-status-dot {
  background: var(--color-success);
}

.file-item--auto .file-status-dot {
  background: var(--color-success);
  opacity: 0.7;
}

.file-item--partial .file-status-dot {
  background: var(--color-warning);
}

.file-item--manual .file-status-dot {
  background: var(--color-danger);
}

.file-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-dir {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-badge {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
  background: var(--color-bg);
  padding: 1px 7px;
  border-radius: 10px;
  flex-shrink: 0;
}
</style>
