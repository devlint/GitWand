<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import type { GitDiff, DiffLine } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import type { DiffMode } from "../utils/diffMode";
import { detectLanguage, highlightLine } from "../utils/highlight";

const { t } = useI18n();

const props = defineProps<{
  diff: GitDiff | null;
  filePath: string | null;
  diffMode: DiffMode;
}>();

const emit = defineEmits<{
  "update:diffMode": [mode: DiffMode];
  "open-file-history": [path: string];
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

/** Detected language for syntax highlighting */
const language = computed(() => props.filePath ? detectLanguage(props.filePath) : null);

/** Highlight a line's content, returns HTML */
function hl(content: string): string {
  return highlightLine(content, language.value);
}

// ─── Side-by-side: pair lines into left/right rows ─────
interface SbsPair {
  left: DiffLine | null;
  right: DiffLine | null;
}

function pairLines(lines: DiffLine[]): SbsPair[] {
  const pairs: SbsPair[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      pairs.push({ left: lines[i], right: lines[i] });
      i++;
    } else {
      const deletes: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "delete") {
        deletes.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].type === "add") {
        adds.push(lines[i]);
        i++;
      }
      const maxLen = Math.max(deletes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        pairs.push({
          left: j < deletes.length ? deletes[j] : null,
          right: j < adds.length ? adds[j] : null,
        });
      }
    }
  }
  return pairs;
}

/** Precomputed paired lines for each hunk (only used in side-by-side mode) */
const pairedHunks = computed(() => {
  if (!props.diff || props.diffMode !== "side-by-side") return [];
  return props.diff.hunks.map((hunk) => pairLines(hunk.lines));
});

// ─── Hunk navigation ────────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const hunkEls = ref<HTMLElement[]>([]);
const currentHunkIdx = ref(0);

function setHunkRef(el: any, idx: number) {
  if (el) hunkEls.value[idx] = el as HTMLElement;
}

const hunkCount = computed(() => props.diff?.hunks.length ?? 0);

function goToHunk(idx: number) {
  if (idx < 0 || idx >= hunkCount.value) return;
  currentHunkIdx.value = idx;
  const el = hunkEls.value[idx];
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function prevHunk() { goToHunk(currentHunkIdx.value - 1); }
function nextHunk() { goToHunk(currentHunkIdx.value + 1); }

// ─── Collapse unchanged: split long context runs ────────
const CONTEXT_VISIBLE = 3; // lines to show before/after changes

interface CollapsedSection {
  type: "lines";
  lines: DiffLine[];
}
interface CollapsedPlaceholder {
  type: "collapsed";
  count: number;
  hunkIdx: number;
  sectionIdx: number;
}
type HunkSection = CollapsedSection | CollapsedPlaceholder;

const expandedSections = ref(new Set<string>());

function sectionKey(hunkIdx: number, sectionIdx: number) {
  return `${hunkIdx}:${sectionIdx}`;
}

function toggleSection(hunkIdx: number, sectionIdx: number) {
  const key = sectionKey(hunkIdx, sectionIdx);
  const s = new Set(expandedSections.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  expandedSections.value = s;
}

/** Split a hunk's lines into sections, collapsing long context runs */
function collapseHunk(hunkIdx: number, lines: DiffLine[]): HunkSection[] {
  if (lines.length <= CONTEXT_VISIBLE * 2 + 2) {
    return [{ type: "lines", lines }];
  }

  const sections: HunkSection[] = [];
  let sectionIdx = 0;
  let i = 0;

  while (i < lines.length) {
    // Find runs of context lines
    if (lines[i].type === "context") {
      let runStart = i;
      while (i < lines.length && lines[i].type === "context") i++;
      const runLen = i - runStart;

      if (runLen > CONTEXT_VISIBLE * 2 + 1) {
        // Show first N context, collapse middle, show last N context
        const headEnd = runStart === 0 ? CONTEXT_VISIBLE : CONTEXT_VISIBLE;
        const tailStart = CONTEXT_VISIBLE;

        sections.push({ type: "lines", lines: lines.slice(runStart, runStart + headEnd) });
        sectionIdx++;

        const collapsedCount = runLen - headEnd - tailStart;
        const key = sectionKey(hunkIdx, sectionIdx);
        if (expandedSections.value.has(key)) {
          sections.push({ type: "lines", lines: lines.slice(runStart + headEnd, i - tailStart) });
        } else {
          sections.push({ type: "collapsed", count: collapsedCount, hunkIdx, sectionIdx });
        }
        sectionIdx++;

        sections.push({ type: "lines", lines: lines.slice(i - tailStart, i) });
        sectionIdx++;
      } else {
        sections.push({ type: "lines", lines: lines.slice(runStart, i) });
        sectionIdx++;
      }
    } else {
      // Non-context: collect until next context
      let runStart = i;
      while (i < lines.length && lines[i].type !== "context") i++;
      sections.push({ type: "lines", lines: lines.slice(runStart, i) });
      sectionIdx++;
    }
  }
  return sections;
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
      <div class="diff-header-right">
        <div class="diff-stats" v-if="hasContent">
          <span class="diff-stat diff-stat--add" v-if="totalStats.additions > 0">
            +{{ totalStats.additions }}
          </span>
          <span class="diff-stat diff-stat--del" v-if="totalStats.deletions > 0">
            -{{ totalStats.deletions }}
          </span>
        </div>
        <!-- Hunk navigation -->
        <div class="diff-hunk-nav" v-if="hasContent && hunkCount > 1">
          <button class="diff-nav-btn" @click="prevHunk" :disabled="currentHunkIdx <= 0" :title="t('diff.prevHunk')">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2L6 10M6 2L3 5M6 2L9 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="diff-nav-count mono">{{ currentHunkIdx + 1 }}/{{ hunkCount }}</span>
          <button class="diff-nav-btn" @click="nextHunk" :disabled="currentHunkIdx >= hunkCount - 1" :title="t('diff.nextHunk')">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 10L6 2M6 10L3 7M6 10L9 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <!-- Toggle inline / side-by-side -->
        <div class="diff-mode-toggle" v-if="hasContent">
          <button
            class="diff-mode-btn"
            :class="{ 'diff-mode-btn--active': diffMode === 'inline' }"
            @click="emit('update:diffMode', 'inline')"
            :title="t('diff.modeInline')"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.6"/><rect x="1" y="6" width="12" height="2" rx="0.5" fill="currentColor"/><rect x="1" y="10" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.6"/></svg>
          </button>
          <button
            class="diff-mode-btn"
            :class="{ 'diff-mode-btn--active': diffMode === 'side-by-side' }"
            @click="emit('update:diffMode', 'side-by-side')"
            :title="t('diff.modeSideBySide')"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
          </button>
        </div>
        <!-- File history button -->
        <button
          v-if="filePath"
          class="diff-history-btn"
          @click="emit('open-file-history', filePath!)"
          :title="t('diff.fileHistory')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M7 4.5V7l2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>

    <!-- Diff content: INLINE mode -->
    <div class="diff-content" ref="contentEl" v-if="hasContent && diffMode === 'inline'">
      <div
        v-for="(hunk, hunkIdx) in diff!.hunks"
        :key="hunkIdx"
        class="diff-hunk"
        :ref="(el) => setHunkRef(el, hunkIdx)"
      >
        <div class="hunk-header mono">
          {{ hunk.header }}
        </div>

        <template v-for="(section, sIdx) in collapseHunk(hunkIdx, hunk.lines)" :key="sIdx">
          <!-- Collapsed placeholder -->
          <div
            v-if="section.type === 'collapsed'"
            class="diff-collapsed"
            @click="toggleSection(section.hunkIdx, section.sectionIdx)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 6h4M6 4v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            <span>{{ t('diff.collapsedLines', String(section.count)) }}</span>
          </div>
          <!-- Visible lines -->
          <table v-else class="diff-table">
            <tbody>
              <tr
                v-for="(line, lineIdx) in section.lines"
                :key="lineIdx"
                class="diff-line"
                :class="`diff-line--${line.type}`"
              >
                <td class="line-no mono">{{ line.oldLineNo ?? '' }}</td>
                <td class="line-no mono">{{ line.newLineNo ?? '' }}</td>
                <td class="line-marker mono">
                  {{ line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ' }}
                </td>
                <td class="line-content mono">
                  <span v-html="hl(line.content) || '\u00a0'"></span>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </div>

    <!-- Diff content: SIDE-BY-SIDE mode -->
    <div class="diff-content" v-else-if="hasContent && diffMode === 'side-by-side'">
      <div
        v-for="(hunk, hunkIdx) in diff!.hunks"
        :key="hunkIdx"
        class="diff-hunk"
      >
        <div class="hunk-header mono">
          {{ hunk.header }}
        </div>

        <table class="diff-table diff-table--sbs">
          <tbody>
            <tr
              v-for="(pair, pairIdx) in pairedHunks[hunkIdx]"
              :key="pairIdx"
              class="diff-line"
            >
              <!-- Left side (old) -->
              <td class="line-no mono" :class="pair.left ? `sbs-cell--${pair.left.type}` : 'sbs-cell--empty'">
                {{ pair.left?.oldLineNo ?? '' }}
              </td>
              <td class="line-marker mono" :class="pair.left ? `sbs-cell--${pair.left.type}` : 'sbs-cell--empty'">
                {{ pair.left?.type === 'delete' ? '-' : pair.left?.type === 'context' ? ' ' : '' }}
              </td>
              <td class="line-content mono sbs-content" :class="pair.left ? `sbs-cell--${pair.left.type}` : 'sbs-cell--empty'">
                <span v-html="pair.left ? (hl(pair.left.content) || '\u00a0') : '\u00a0'"></span>
              </td>
              <!-- Separator -->
              <td class="sbs-gutter"></td>
              <!-- Right side (new) -->
              <td class="line-no mono" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                {{ pair.right?.newLineNo ?? '' }}
              </td>
              <td class="line-marker mono" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                {{ pair.right?.type === 'add' ? '+' : pair.right?.type === 'context' ? ' ' : '' }}
              </td>
              <td class="line-content mono sbs-content" :class="pair.right ? `sbs-cell--${pair.right.type}` : 'sbs-cell--empty'">
                <span v-html="pair.right ? (hl(pair.right.content) || '\u00a0') : '\u00a0'"></span>
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
      <span class="diff-empty-text">{{ t('diff.noDiff') }}</span>
      <span class="diff-empty-hint muted">{{ t('diff.noDiffHint') }}</span>
    </div>

    <!-- No file selected -->
    <div class="diff-empty" v-else>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" stroke="var(--color-text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>
      </svg>
      <span class="diff-empty-text">{{ t('diff.selectFile') }}</span>
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

.diff-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
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

/* ─── Mode toggle ────────────────────────────────────── */
.diff-mode-toggle {
  display: flex;
  gap: 2px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  padding: 2px;
}

.diff-mode-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.diff-mode-btn:hover {
  color: var(--color-text);
}

.diff-mode-btn--active {
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

/* ─── Diff content ───────────────────────────────────── */
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

/* ─── Inline mode lines ──────────────────────────────── */
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

/* ─── Side-by-side mode ──────────────────────────────── */
.diff-table--sbs {
  table-layout: fixed;
}

.diff-table--sbs .line-no {
  width: 40px;
  min-width: 40px;
  padding: 0 6px;
}

.diff-table--sbs .line-marker {
  width: 18px;
  min-width: 18px;
  padding: 0 2px;
}

.diff-table--sbs .sbs-content {
  width: calc(50% - 60px);
  padding: 0 8px;
  font-size: 12px;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sbs-gutter {
  width: 4px;
  min-width: 4px;
  background: var(--color-border);
  padding: 0;
}

.sbs-cell--context {
  background: var(--color-bg);
}

.sbs-cell--delete {
  background: rgba(239, 68, 68, 0.1);
}

.sbs-cell--add {
  background: rgba(34, 197, 94, 0.1);
}

.sbs-cell--empty {
  background: var(--color-bg-tertiary);
  opacity: 0.5;
}

.sbs-cell--delete.line-marker,
.sbs-cell--add.line-marker {
  font-weight: 700;
}

.sbs-cell--delete.line-marker {
  color: var(--color-danger);
}

.sbs-cell--add.line-marker {
  color: var(--color-success);
}

.sbs-cell--delete.line-no {
  color: var(--color-danger);
  opacity: 0.7;
}

.sbs-cell--add.line-no {
  color: var(--color-success);
  opacity: 0.7;
}

/* ─── File history button ────────────────────────────── */
.diff-history-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.diff-history-btn:hover {
  background: var(--color-border);
  color: var(--color-accent);
}

/* ─── Hunk navigation ────────────────────────────────── */
.diff-hunk-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.diff-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.diff-nav-btn:hover:not(:disabled) {
  background: var(--color-border);
  color: var(--color-text);
}

.diff-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.diff-nav-count {
  font-size: 10px;
  color: var(--color-text-muted);
  min-width: 28px;
  text-align: center;
}

/* ─── Collapsed context ──────────────────────────────── */
.diff-collapsed {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 16px;
  font-size: 11px;
  color: var(--color-accent);
  background: var(--color-bg-tertiary);
  cursor: pointer;
  user-select: none;
  border-top: 1px dashed var(--color-border);
  border-bottom: 1px dashed var(--color-border);
  transition: background 0.12s;
}

.diff-collapsed:hover {
  background: var(--color-bg-secondary);
}

/* ─── Empty states ───────────────────────────────────── */
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
