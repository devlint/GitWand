<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from "vue";
import type { GitDiff, GitLogEntry, DiffLine } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import type { DiffMode } from "../utils/diffMode";
import { detectLanguage, highlightLine } from "../utils/highlight";
import { wordDiff, segmentsToHtml } from "../utils/wordDiff";

const { t } = useI18n();

const props = defineProps<{
  diffs: GitDiff[];
  commitHash: string | null;
  commitInfo: GitLogEntry | null;
  diffMode: DiffMode;
}>();

const emit = defineEmits<{
  "update:diffMode": [mode: DiffMode];
}>();

// ─── Side-by-side line pairing with word-diff ────────
interface SbsPair {
  left: DiffLine | null;
  right: DiffLine | null;
  leftHtml?: string;
  rightHtml?: string;
}

/** Highlight a line of content for a given file path */
function hl(content: string, filePath: string): string {
  const lang = detectLanguage(filePath);
  return highlightLine(content, lang);
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
        const del = j < deletes.length ? deletes[j] : null;
        const add = j < adds.length ? adds[j] : null;
        const pair: SbsPair = { left: del, right: add };
        if (del && add) {
          const wd = wordDiff(del.content, add.content);
          pair.leftHtml = segmentsToHtml(wd.oldSegments);
          pair.rightHtml = segmentsToHtml(wd.newSegments);
        }
        pairs.push(pair);
      }
    }
  }
  return pairs;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

// Deterministic pastel color from author name
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function cleanBody(raw: string): string {
  // Replace literal \n sequences with real newlines, then trim
  return raw.replace(/\\n/g, "\n").trim();
}

function formatDate(raw: string): string {
  try {
    const d = new Date(raw);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 30) return `${diffD}d ago`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return raw;
  }
}

// ─── Cached diff stats (computed once per diffs change) ──
const fileStats = computed(() =>
  props.diffs.map((diff) => {
    let adds = 0;
    let dels = 0;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") adds++;
        else if (line.type === "delete") dels++;
      }
    }
    return { adds, dels };
  }),
);

const totalStats = computed(() => {
  let adds = 0;
  let dels = 0;
  for (const s of fileStats.value) {
    adds += s.adds;
    dels += s.dels;
  }
  return { adds, dels, files: props.diffs.length };
});

// ─── Lazy rendering: only expand a few files at a time ──
const MAX_INITIAL_FILES = 20;
const MAX_LINES_PER_FILE = 500;

/** Set of expanded file indices */
const expandedFiles = ref(new Set<number>());

/** How many files to show in the list (grows on scroll) */
const renderedFileCount = ref(MAX_INITIAL_FILES);

function isExpanded(idx: number): boolean {
  return expandedFiles.value.has(idx);
}

function toggleFile(idx: number) {
  const s = new Set(expandedFiles.value);
  if (s.has(idx)) {
    s.delete(idx);
  } else {
    s.add(idx);
  }
  expandedFiles.value = s;
}

/** Total lines in a file diff */
function fileTotalLines(idx: number): number {
  let count = 0;
  for (const hunk of props.diffs[idx].hunks) {
    count += hunk.lines.length;
  }
  return count;
}

/** Whether a file diff is truncated (too many lines) */
function isFileTruncated(idx: number): boolean {
  return fileTotalLines(idx) > MAX_LINES_PER_FILE;
}

/** Get hunks with truncation applied */
function truncatedHunks(idx: number) {
  const diff = props.diffs[idx];
  if (!isFileTruncated(idx)) return diff.hunks;

  const result: typeof diff.hunks = [];
  let remaining = MAX_LINES_PER_FILE;

  for (const hunk of diff.hunks) {
    if (remaining <= 0) break;
    if (hunk.lines.length <= remaining) {
      result.push(hunk);
      remaining -= hunk.lines.length;
    } else {
      result.push({ ...hunk, lines: hunk.lines.slice(0, remaining) });
      remaining = 0;
    }
  }
  return result;
}

// Reset expansion and rendered count when diffs change
watch(
  () => props.diffs,
  () => {
    // Auto-expand the first few files
    const initial = new Set<number>();
    const autoExpand = Math.min(props.diffs.length, 5);
    for (let i = 0; i < autoExpand; i++) {
      initial.add(i);
    }
    expandedFiles.value = initial;
    renderedFileCount.value = Math.min(props.diffs.length, MAX_INITIAL_FILES);
    visibleFileIdx.value = 0;
  },
);

// ─── Scroll-spy: track which file is visible ────────────
const contentEl = ref<HTMLElement | null>(null);
const fileEls = ref<HTMLElement[]>([]);
const visibleFileIdx = ref(0);

let observer: IntersectionObserver | null = null;
const visibleSet = new Map<number, number>();

function setupObserver() {
  teardownObserver();
  if (!contentEl.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.fileIdx);
        if (entry.isIntersecting) {
          visibleSet.set(idx, entry.intersectionRatio);
        } else {
          visibleSet.delete(idx);
        }
      }
      if (visibleSet.size > 0) {
        visibleFileIdx.value = Math.min(...visibleSet.keys());
      }
    },
    { root: contentEl.value, threshold: [0, 0.1, 0.5] },
  );

  for (const el of fileEls.value) {
    if (el) observer.observe(el);
  }
}

function teardownObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  visibleSet.clear();
}

watch(
  () => props.diffs,
  async () => {
    await nextTick();
    setupObserver();
  },
);

onUnmounted(() => teardownObserver());

// Click on a file in the list → expand & scroll to it
function scrollToFile(idx: number) {
  // Ensure file is rendered
  if (idx >= renderedFileCount.value) {
    renderedFileCount.value = idx + 1;
  }
  // Ensure file is expanded
  if (!expandedFiles.value.has(idx)) {
    const s = new Set(expandedFiles.value);
    s.add(idx);
    expandedFiles.value = s;
  }
  nextTick(() => {
    const el = fileEls.value[idx];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

// Collect refs
function setFileRef(el: any, idx: number) {
  if (el) fileEls.value[idx] = el as HTMLElement;
}

// ─── Load more on scroll ─────────────────────────────────
function onContentScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (!el) return;
  const scrollBottom = el.scrollTop + el.clientHeight;
  const threshold = el.scrollHeight - 200;
  if (scrollBottom >= threshold && renderedFileCount.value < props.diffs.length) {
    renderedFileCount.value = Math.min(
      renderedFileCount.value + MAX_INITIAL_FILES,
      props.diffs.length,
    );
    nextTick(() => setupObserver());
  }
}
</script>

<template>
  <div class="commit-diff-viewer">
    <!-- Commit card -->
    <div class="cdv-commit-card" v-if="commitInfo">
      <!-- Row 1: avatar + subject + hash -->
      <div class="cdv-commit-top">
        <span class="cdv-avatar" :style="{ background: avatarColor(commitInfo.author) }">
          {{ commitInfo.author.charAt(0).toUpperCase() }}
        </span>
        <div class="cdv-commit-top-text">
          <div class="cdv-commit-subject">{{ commitInfo.message }}</div>
          <div class="cdv-commit-meta">
            <span class="cdv-author">{{ commitInfo.author }}</span>
            <span class="cdv-meta-sep">&middot;</span>
            <span class="cdv-date">{{ formatDate(commitInfo.date) }}</span>
            <span class="cdv-meta-sep">&middot;</span>
            <span class="cdv-hash mono" :title="commitInfo.hashFull">{{ commitInfo.hash }}</span>
          </div>
        </div>
      </div>
      <!-- Row 2: body (if any) -->
      <div class="cdv-commit-body" v-if="commitInfo.body">{{ cleanBody(commitInfo.body) }}</div>
      <!-- Row 3: stats badges -->
      <div class="cdv-commit-stats">
        <span class="cdv-badge cdv-badge--files">
          {{ totalStats.files }} {{ totalStats.files === 1 ? t('header.file') : t('header.files') }}
        </span>
        <span class="cdv-badge cdv-badge--add" v-if="totalStats.adds > 0">+{{ totalStats.adds }}</span>
        <span class="cdv-badge cdv-badge--del" v-if="totalStats.dels > 0">&minus;{{ totalStats.dels }}</span>
        <span class="cdv-large-diff-hint" v-if="diffs.length > MAX_INITIAL_FILES">
          ({{ renderedFileCount }}/{{ diffs.length }})
        </span>
        <!-- Toggle inline / side-by-side -->
        <div class="cdv-mode-toggle">
          <button
            class="cdv-mode-btn"
            :class="{ 'cdv-mode-btn--active': diffMode === 'inline' }"
            @click="emit('update:diffMode', 'inline')"
            :title="t('diff.modeInline')"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.6"/><rect x="1" y="6" width="12" height="2" rx="0.5" fill="currentColor"/><rect x="1" y="10" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.6"/></svg>
          </button>
          <button
            class="cdv-mode-btn"
            :class="{ 'cdv-mode-btn--active': diffMode === 'side-by-side' }"
            @click="emit('update:diffMode', 'side-by-side')"
            :title="t('diff.modeSideBySide')"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
          </button>
        </div>
      </div>
    </div>

    <div class="cdv-body" v-if="diffs.length > 0">
      <!-- File diffs -->
      <div class="cdv-content" ref="contentEl" @scroll="onContentScroll">
        <div
          v-for="fileIdx in renderedFileCount"
          :key="fileIdx - 1"
          class="cdv-file"
          :ref="(el) => setFileRef(el, fileIdx - 1)"
          :data-file-idx="fileIdx - 1"
        >
          <!-- Collapsible file header -->
          <div
            class="cdv-file-header"
            @click="toggleFile(fileIdx - 1)"
            role="button"
            tabindex="0"
            @keydown.enter="toggleFile(fileIdx - 1)"
          >
            <span class="cdv-collapse-icon" :class="{ 'cdv-collapse-icon--open': isExpanded(fileIdx - 1) }">&#9654;</span>
            <span class="cdv-file-name mono">{{ fileName(diffs[fileIdx - 1].path) }}</span>
            <span class="cdv-file-path muted">{{ diffs[fileIdx - 1].path }}</span>
            <div class="cdv-file-stats">
              <span class="cdv-stat cdv-stat--add" v-if="fileStats[fileIdx - 1]?.adds > 0">
                +{{ fileStats[fileIdx - 1].adds }}
              </span>
              <span class="cdv-stat cdv-stat--del" v-if="fileStats[fileIdx - 1]?.dels > 0">
                -{{ fileStats[fileIdx - 1].dels }}
              </span>
            </div>
          </div>

          <!-- Hunks (only rendered if expanded) -->
          <template v-if="isExpanded(fileIdx - 1)">
            <div
              v-for="(hunk, hunkIdx) in truncatedHunks(fileIdx - 1)"
              :key="hunkIdx"
              class="cdv-hunk"
            >
              <div class="cdv-hunk-header mono">{{ hunk.header }}</div>

              <!-- INLINE mode -->
              <table v-if="diffMode === 'inline'" class="cdv-table">
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
                      <span v-html="hl(line.content, diffs[fileIdx - 1].path) || '\u00a0'"></span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <!-- SIDE-BY-SIDE mode -->
              <table v-else class="cdv-table cdv-table--sbs">
                <tbody>
                  <tr
                    v-for="(pair, pairIdx) in pairLines(hunk.lines)"
                    :key="pairIdx"
                    class="cdv-line"
                  >
                    <td class="cdv-line-no mono" :class="pair.left ? `cdv-sbs--${pair.left.type}` : 'cdv-sbs--empty'">
                      {{ pair.left?.oldLineNo ?? '' }}
                    </td>
                    <td class="cdv-line-marker mono" :class="pair.left ? `cdv-sbs--${pair.left.type}` : 'cdv-sbs--empty'">
                      {{ pair.left?.type === 'delete' ? '-' : pair.left?.type === 'context' ? ' ' : '' }}
                    </td>
                    <td class="cdv-line-content mono cdv-sbs-content" :class="pair.left ? `cdv-sbs--${pair.left.type}` : 'cdv-sbs--empty'">
                      <span v-html="pair.leftHtml ?? (pair.left ? (hl(pair.left.content, diffs[fileIdx - 1].path) || '\u00a0') : '\u00a0')"></span>
                    </td>
                    <td class="cdv-sbs-gutter"></td>
                    <td class="cdv-line-no mono" :class="pair.right ? `cdv-sbs--${pair.right.type}` : 'cdv-sbs--empty'">
                      {{ pair.right?.newLineNo ?? '' }}
                    </td>
                    <td class="cdv-line-marker mono" :class="pair.right ? `cdv-sbs--${pair.right.type}` : 'cdv-sbs--empty'">
                      {{ pair.right?.type === 'add' ? '+' : pair.right?.type === 'context' ? ' ' : '' }}
                    </td>
                    <td class="cdv-line-content mono cdv-sbs-content" :class="pair.right ? `cdv-sbs--${pair.right.type}` : 'cdv-sbs--empty'">
                      <span v-html="pair.rightHtml ?? (pair.right ? (hl(pair.right.content, diffs[fileIdx - 1].path) || '\u00a0') : '\u00a0')"></span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="isFileTruncated(fileIdx - 1)" class="cdv-truncated">
              Diff truncated ({{ fileTotalLines(fileIdx - 1) }} lines, showing first {{ MAX_LINES_PER_FILE }})
            </div>
          </template>
        </div>

        <!-- Load more indicator -->
        <div v-if="renderedFileCount < diffs.length" class="cdv-load-more">
          {{ diffs.length - renderedFileCount }} more files — scroll down to load
        </div>
      </div>

      <!-- Right-side file list -->
      <aside class="cdv-filelist">
        <div class="cdv-filelist-title">{{ t('header.files') }}</div>
        <ul class="cdv-filelist-items">
          <li
            v-for="(fileDiff, idx) in diffs"
            :key="idx"
            class="cdv-filelist-item"
            :class="{ 'cdv-filelist-item--active': idx === visibleFileIdx }"
            @click="scrollToFile(idx)"
            :title="fileDiff.path"
          >
            <span class="cdv-filelist-icon mono" :class="{
              'cdv-filelist-icon--add': fileStats[idx]?.adds > 0 && fileStats[idx]?.dels === 0,
              'cdv-filelist-icon--del': fileStats[idx]?.dels > 0 && fileStats[idx]?.adds === 0,
              'cdv-filelist-icon--mod': fileStats[idx]?.adds > 0 && fileStats[idx]?.dels > 0,
            }">{{ fileStats[idx]?.adds > 0 && fileStats[idx]?.dels === 0 ? 'A' : fileStats[idx]?.dels > 0 && fileStats[idx]?.adds === 0 ? 'D' : 'M' }}</span>
            <span class="cdv-filelist-name">{{ fileName(fileDiff.path) }}</span>
            <span class="cdv-filelist-stats">
              <span v-if="fileStats[idx]?.adds > 0" class="cdv-stat cdv-stat--add">+{{ fileStats[idx].adds }}</span>
              <span v-if="fileStats[idx]?.dels > 0" class="cdv-stat cdv-stat--del">-{{ fileStats[idx].dels }}</span>
            </span>
          </li>
        </ul>
      </aside>
    </div>

    <!-- Empty state -->
    <div class="cdv-empty" v-else-if="commitHash">
      <span class="muted">{{ t('log.noDiffForCommit') }}</span>
    </div>
    <div class="cdv-empty" v-else>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" stroke="var(--color-text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>
      </svg>
      <span class="muted">{{ t('log.selectCommit') }}</span>
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

.cdv-commit-card {
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cdv-commit-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.cdv-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.cdv-commit-top-text {
  flex: 1;
  min-width: 0;
}

.cdv-commit-subject {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.4;
}

.cdv-commit-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.cdv-meta-sep {
  opacity: 0.4;
}

.cdv-author {
  font-weight: 500;
}

.cdv-hash {
  font-size: 10px;
  color: var(--color-accent);
  background: var(--color-bg-tertiary);
  padding: 1px 6px;
  border-radius: 4px;
}

.cdv-commit-body {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-text-muted);
  line-height: 1.5;
  white-space: pre-wrap;
  padding-left: 44px;
}

.cdv-commit-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 44px;
}

.cdv-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}

.cdv-badge--files {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.cdv-badge--add {
  background: rgba(63, 185, 80, 0.15);
  color: var(--color-success);
}

.cdv-badge--del {
  background: rgba(248, 81, 73, 0.15);
  color: var(--color-danger);
}

.cdv-summary {
  font-size: 12px;
  color: var(--color-text-muted);
}

.cdv-large-diff-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.6;
}

.cdv-stat {
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.cdv-stat--add {
  color: var(--color-success);
}

.cdv-stat--del {
  color: var(--color-danger);
}

/* ─── Body: diff + file list side by side ─────────────── */

.cdv-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.cdv-content {
  flex: 1;
  overflow: auto;
}

/* ─── Right-side file list ────────────────────────────── */

.cdv-filelist {
  width: 220px;
  min-width: 180px;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cdv-filelist-title {
  padding: 8px 12px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.cdv-filelist-items {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
}

.cdv-filelist-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s;
  border-left: 2px solid transparent;
}

.cdv-filelist-item:hover {
  background: var(--color-bg-tertiary);
}

.cdv-filelist-item--active {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

.cdv-filelist-icon {
  font-size: 10px;
  font-weight: 700;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.cdv-filelist-icon--add { color: var(--color-success); }
.cdv-filelist-icon--del { color: var(--color-danger); }
.cdv-filelist-icon--mod { color: var(--color-warning); }

.cdv-filelist-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.cdv-filelist-item--active .cdv-filelist-name {
  font-weight: 600;
}

.cdv-filelist-stats {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* ─── File diff blocks ────────────────────────────────── */

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
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}

.cdv-file-header:hover {
  background: var(--color-bg-tertiary);
}

.cdv-collapse-icon {
  font-size: 10px;
  color: var(--color-text-muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.cdv-collapse-icon--open {
  transform: rotate(90deg);
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

/* ─── Side-by-side mode ──────────────────────────────── */
.cdv-table--sbs {
  table-layout: fixed;
}

.cdv-table--sbs .cdv-line-no {
  width: 36px;
  min-width: 36px;
}

.cdv-table--sbs .cdv-line-marker {
  width: 16px;
  min-width: 16px;
}

.cdv-sbs-content {
  width: calc(50% - 56px);
}

.cdv-sbs-gutter {
  width: 4px;
  min-width: 4px;
  background: var(--color-border);
  padding: 0;
}

.cdv-sbs--context { background: var(--color-bg); }
.cdv-sbs--delete { background: rgba(239, 68, 68, 0.1); }
.cdv-sbs--add { background: rgba(34, 197, 94, 0.1); }
.cdv-sbs--empty { background: var(--color-bg-tertiary); opacity: 0.5; }

.cdv-sbs--delete.cdv-line-marker { color: var(--color-danger); font-weight: 700; }
.cdv-sbs--add.cdv-line-marker { color: var(--color-success); font-weight: 700; }
.cdv-sbs--delete.cdv-line-no { color: var(--color-danger); opacity: 0.7; }
.cdv-sbs--add.cdv-line-no { color: var(--color-success); opacity: 0.7; }

/* ─── Mode toggle ────────────────────────────────────── */
.cdv-mode-toggle {
  display: flex;
  gap: 2px;
  background: var(--color-bg-tertiary);
  border-radius: 6px;
  padding: 2px;
  margin-left: auto;
}

.cdv-mode-btn {
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

.cdv-mode-btn:hover {
  color: var(--color-text);
}

.cdv-mode-btn--active {
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.cdv-truncated {
  padding: 8px 16px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  text-align: center;
  font-style: italic;
}

.cdv-load-more {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
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
