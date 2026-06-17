<script setup lang="ts">
/**
 * FolderDiffTree — GitWand v1.6.3 folder diff (P0 scope)
 *
 * Renders the aggregated diff tree returned by the `folderDiff` backend
 * command. Displays each directory with its rolled-up stats (+/− lines,
 * file count) and lets the user filter the main diff to a subtree by
 * clicking a folder, or open a file's diff by clicking a file.
 *
 * The component is "flattened render" over a recursive tree: visible nodes
 * are projected into a single list of rows that respect the `expanded`
 * set. This keeps keyboard navigation simple (just move a cursor up/down
 * in the row array) without juggling a recursive component.
 *
 * Keyboard nav (when the tree has focus):
 *   ↑/↓     — move cursor
 *   ←       — collapse folder, or jump to parent
 *   →       — expand folder, or move to first child
 *   Enter   — activate row (folder = filter, file = open diff)
 *   Escape  — clear the active folder filter
 *
 * Emits (P0):
 *   select-folder (path)  — user picked a folder to filter the file view
 *   select-file   (path)  — user picked a file to open in the diff viewer
 *   clear-filter  ()      — user asked to drop the folder filter
 */
import { computed, ref, watch, nextTick } from "vue";
import type { FolderDiffNode } from "../utils/backend";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  /** Root node returned by `folderDiff`. Its own children are the top-level entries to render. */
  tree: FolderDiffNode;
  /** Path of the currently active folder filter, or null for no filter. */
  selectedFolderPath?: string | null;
  /** Path of the currently open file (to highlight in the tree), or null. */
  selectedFilePath?: string | null;
}>();

const emit = defineEmits<{
  "select-folder": [path: string];
  "select-file": [path: string];
  "clear-filter": [];
}>();

// ─── Expanded state ──────────────────────────────────────────
// Open by default: all folders whose depth ≤ 1 (top-level folders).
// Deeper folders start collapsed to avoid an overwhelming initial view.
const expanded = ref<Set<string>>(new Set());

function initExpanded(node: FolderDiffNode, depth: number) {
  for (const child of node.children) {
    if (child.kind === "folder" && depth <= 1) {
      expanded.value.add(child.path);
    }
    if (child.kind === "folder") {
      initExpanded(child, depth + 1);
    }
  }
}

// Re-seed expansion whenever the tree identity changes (new diff).
watch(
  () => props.tree,
  (t) => {
    expanded.value = new Set();
    initExpanded(t, 0);
  },
  { immediate: true },
);

// ─── Flattened rows for rendering + keyboard nav ─────────────
interface Row {
  path: string;
  name: string;
  kind: "folder" | "file";
  depth: number;
  status: string | null;
  oldPath: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  binary: boolean;
  hasChildren: boolean;
  isExpanded: boolean;
}

function flattenNode(node: FolderDiffNode, depth: number, out: Row[]) {
  for (const child of node.children) {
    const isFolder = child.kind === "folder";
    const hasChildren = child.children.length > 0;
    const open = isFolder && expanded.value.has(child.path);
    out.push({
      path: child.path,
      name: child.name,
      kind: child.kind,
      depth,
      status: child.status,
      oldPath: child.oldPath,
      filesChanged: child.filesChanged,
      additions: child.additions,
      deletions: child.deletions,
      binary: child.binary,
      hasChildren,
      isExpanded: open,
    });
    if (open) flattenNode(child, depth + 1, out);
  }
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  flattenNode(props.tree, 0, out);
  return out;
});

// ─── Cursor (keyboard focus) ─────────────────────────────────
// Index into `rows`. -1 means no row is focused.
const cursor = ref<number>(-1);
const listEl = ref<HTMLElement | null>(null);

function moveCursor(delta: number) {
  if (rows.value.length === 0) return;
  const next = Math.max(0, Math.min(rows.value.length - 1, cursor.value + delta));
  cursor.value = next;
  scrollIntoView(next);
}

function scrollIntoView(idx: number) {
  if (!listEl.value) return;
  nextTick(() => {
    const rowEl = listEl.value?.querySelector<HTMLElement>(`[data-row-index="${idx}"]`);
    rowEl?.scrollIntoView({ block: "nearest" });
  });
}

function toggleExpand(path: string, force?: boolean) {
  if (force === true) expanded.value.add(path);
  else if (force === false) expanded.value.delete(path);
  else if (expanded.value.has(path)) expanded.value.delete(path);
  else expanded.value.add(path);
  // Trigger reactivity (Set mutations don't auto-notify).
  expanded.value = new Set(expanded.value);
}

function activateRow(idx: number) {
  const row = rows.value[idx];
  if (!row) return;
  if (row.kind === "folder") {
    // Folder click filters AND toggles expand.
    emit("select-folder", row.path);
    toggleExpand(row.path);
  } else {
    emit("select-file", row.path);
  }
}

function onKeydown(e: KeyboardEvent) {
  if (rows.value.length === 0) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveCursor(cursor.value < 0 ? 1 : 1);
      if (cursor.value < 0) cursor.value = 0;
      break;
    case "ArrowUp":
      e.preventDefault();
      if (cursor.value <= 0) cursor.value = 0;
      else moveCursor(-1);
      break;
    case "ArrowRight": {
      e.preventDefault();
      const r = rows.value[cursor.value];
      if (!r) return;
      if (r.kind === "folder" && r.hasChildren && !r.isExpanded) {
        toggleExpand(r.path, true);
      } else if (r.kind === "folder" && r.isExpanded) {
        moveCursor(1);
      }
      break;
    }
    case "ArrowLeft": {
      e.preventDefault();
      const r = rows.value[cursor.value];
      if (!r) return;
      if (r.kind === "folder" && r.isExpanded) {
        toggleExpand(r.path, false);
      } else {
        // Jump to parent row (same path minus last segment).
        const parentPath = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
        if (parentPath) {
          const parentIdx = rows.value.findIndex((x) => x.path === parentPath);
          if (parentIdx >= 0) {
            cursor.value = parentIdx;
            scrollIntoView(parentIdx);
          }
        }
      }
      break;
    }
    case "Enter":
      e.preventDefault();
      if (cursor.value >= 0) activateRow(cursor.value);
      break;
    case "Escape":
      e.preventDefault();
      emit("clear-filter");
      break;
  }
}

// Status letter + accessible label.
function statusLabel(row: Row): string {
  if (row.kind !== "file") return "";
  switch (row.status) {
    case "A": return t("folderDiff.statusAdded");
    case "M": return t("folderDiff.statusModified");
    case "D": return t("folderDiff.statusDeleted");
    case "R": return t("folderDiff.statusRenamed");
    case "C": return t("folderDiff.statusCopied");
    case "T": return t("folderDiff.statusTypeChanged");
    default: return "";
  }
}

function statusClass(row: Row): string {
  if (row.kind !== "file") return "";
  const s = (row.status || "").toUpperCase();
  if (s === "A") return "status-added";
  if (s === "M") return "status-modified";
  if (s === "D") return "status-deleted";
  if (s === "R" || s === "C") return "status-renamed";
  if (s === "T") return "status-modified";
  return "";
}

function folderStatsLabel(row: Row): string {
  // "+N / -M · K files"
  const files = row.filesChanged > 1
    ? t("folderDiff.filesPlural", row.filesChanged)
    : t("folderDiff.filesSingular", row.filesChanged);
  return `+${row.additions} / −${row.deletions} · ${files}`;
}

function fileStatsLabel(row: Row): string {
  if (row.binary) return t("folderDiff.binary");
  return `+${row.additions} / −${row.deletions}`;
}

const rootStatsLabel = computed(() => {
  const n = props.tree;
  if (n.filesChanged === 0) return t("folderDiff.noChanges");
  const files = n.filesChanged > 1
    ? t("folderDiff.filesPlural", n.filesChanged)
    : t("folderDiff.filesSingular", n.filesChanged);
  return `${files} · +${n.additions} / −${n.deletions}`;
});

function isFilterActive(path: string): boolean {
  return props.selectedFolderPath === path;
}

function isFileSelected(path: string): boolean {
  return props.selectedFilePath === path;
}
</script>

<template>
  <nav
    ref="listEl"
    class="folder-diff-tree"
    :aria-label="t('folderDiff.treeAria')"
    tabindex="0"
    @keydown="onKeydown"
  >
    <header class="folder-diff-header">
      <span class="folder-diff-title">{{ t("folderDiff.title") }}</span>
      <span class="folder-diff-summary" :title="rootStatsLabel">{{ rootStatsLabel }}</span>
      <button
        v-if="selectedFolderPath"
        type="button"
        class="folder-diff-clear"
        :title="t('folderDiff.clearFilter')"
        :aria-label="t('folderDiff.clearFilter')"
        @click="emit('clear-filter')"
      >
        ×
      </button>
    </header>

    <ul v-if="rows.length > 0" class="folder-diff-rows" role="tree">
      <li
        v-for="(row, i) in rows"
        :key="row.path"
        :data-row-index="i"
        class="folder-diff-row"
        :class="{
          'folder-diff-row--folder': row.kind === 'folder',
          'folder-diff-row--file': row.kind === 'file',
          'folder-diff-row--cursor': cursor === i,
          'folder-diff-row--active': row.kind === 'folder' && isFilterActive(row.path),
          'folder-diff-row--selected': row.kind === 'file' && isFileSelected(row.path),
        }"
        role="treeitem"
        :aria-level="row.depth + 1"
        :aria-expanded="row.kind === 'folder' ? row.isExpanded : undefined"
        :aria-selected="row.kind === 'file' && isFileSelected(row.path)"
        @click="activateRow(i); cursor = i"
      >
        <span
          class="folder-diff-indent"
          :style="{ width: `${row.depth * 14}px` }"
          aria-hidden="true"
        />
        <span
          v-if="row.kind === 'folder'"
          class="folder-diff-chevron"
          :class="{ 'folder-diff-chevron--open': row.isExpanded }"
          :aria-hidden="true"
        >▸</span>
        <span
          v-else
          class="folder-diff-status"
          :class="statusClass(row)"
          :title="statusLabel(row)"
          :aria-label="statusLabel(row)"
        >{{ (row.status || "").charAt(0) }}</span>

        <span class="folder-diff-name" :title="row.path">{{ row.name }}</span>

        <span
          v-if="row.kind === 'file' && row.oldPath"
          class="folder-diff-rename"
          :title="t('folderDiff.renamedFrom', row.oldPath)"
        >← {{ row.oldPath }}</span>

        <span class="folder-diff-stats">
          {{ row.kind === "folder" ? folderStatsLabel(row) : fileStatsLabel(row) }}
        </span>
      </li>
    </ul>
    <p v-else class="folder-diff-empty">{{ t("folderDiff.noChanges") }}</p>
  </nav>
</template>

<style scoped>
.folder-diff-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  outline: none;
  font-size: 13px;
}
.folder-diff-tree:focus-visible {
  outline: 2px solid var(--color-accent, #3b82f6);
  outline-offset: -2px;
}

.folder-diff-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  font-weight: 600;
}
.folder-diff-title {
  flex-shrink: 0;
}
.folder-diff-summary {
  flex: 1;
  color: var(--color-text-muted, #6b7280);
  font-weight: 400;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-diff-clear {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-muted, #6b7280);
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
}
.folder-diff-clear:hover {
  background: var(--color-hover, #f3f4f6);
  color: var(--color-text, #111827);
}

.folder-diff-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}

.folder-diff-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  cursor: pointer;
  user-select: none;
  line-height: 1.3;
}
.folder-diff-row:hover {
  background: var(--color-hover, #f3f4f6);
}
.folder-diff-row--cursor {
  background: var(--color-hover-strong, #e5e7eb);
}
.folder-diff-row--active,
.folder-diff-row--selected {
  background: var(--color-selected, #dbeafe);
  color: var(--color-selected-text, #1e3a8a);
}

.folder-diff-indent {
  display: inline-block;
  flex-shrink: 0;
}

.folder-diff-chevron {
  display: inline-block;
  width: 12px;
  flex-shrink: 0;
  color: var(--color-text-muted, #6b7280);
  transition: transform 120ms;
  transform-origin: center;
}
.folder-diff-chevron--open {
  transform: rotate(90deg);
}

.folder-diff-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  font-family: ui-monospace, monospace;
}
.folder-diff-status.status-added {
  background: #dcfce7;
  color: #166534;
}
.folder-diff-status.status-modified {
  background: #fef3c7;
  color: #92400e;
}
.folder-diff-status.status-deleted {
  background: #fee2e2;
  color: #991b1b;
}
.folder-diff-status.status-renamed {
  background: #dbeafe;
  color: #1e40af;
}

.folder-diff-name {
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}
.folder-diff-row--folder .folder-diff-name {
  font-weight: 500;
}

.folder-diff-rename {
  color: var(--color-text-muted, #6b7280);
  font-size: 11px;
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
  min-width: 0;
}

.folder-diff-stats {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--color-text-muted, #6b7280);
  flex-shrink: 0;
  font-family: ui-monospace, monospace;
}
.folder-diff-row--active .folder-diff-stats,
.folder-diff-row--selected .folder-diff-stats {
  color: inherit;
}

.folder-diff-empty {
  padding: 16px 12px;
  color: var(--color-text-muted, #6b7280);
  font-style: italic;
  text-align: center;
  margin: 0;
}
</style>
