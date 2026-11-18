<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick, inject } from "vue";
import type { GitDiff, GitLogEntry, DiffLine, FolderDiffNode } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { avatarStyle } from "../composables/useAvatar";
import Avatar from "./Avatar.vue";
import type { DiffMode } from "../utils/diffMode";
import { detectLanguage, highlightLine } from "../utils/highlight";
import { safeHtml } from "../composables/useSafeHtml";
import { wordDiff, segmentsToHtml } from "../utils/wordDiff";
import { CREATE_ISSUE_KEY, useSelectionPublisher } from "../composables/useCreateIssue";
import { useLineRange, preventShiftSelect } from "../composables/useLineRange";
import { parseRowGroup, rowGroup, rowsInColumn, type RowSide } from "../utils/diffRange";
import type { DiffSelection } from "../utils/issuePrefill";

const { t } = useI18n();

const props = defineProps<{
  diffs: GitDiff[];
  /** The commit `diffs` belong to (the previous one's stay while a newly
   *  selected commit loads). */
  diffsHash?: string | null;
  commitHash: string | null;
  commitInfo: GitLogEntry | null;
  diffMode: DiffMode;
  scrollToFileIdx?: number | null;
}>();

const emit = defineEmits<{
  "update:diffMode": [mode: DiffMode];
  "update:visibleFileIdx": [idx: number];
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

/**
 * Side-by-side pairs of a hunk, with their final (sanitised) HTML, computed
 * once per hunk: a re-render (a line selected, a file expanded) must not
 * redo the word diffs, the highlighting and the sanitising of every line.
 */
const pairCache = new WeakMap<DiffLine[], SbsPair[]>();
function pairsOf(lines: DiffLine[], path: string): SbsPair[] {
  let pairs = pairCache.get(lines);
  if (!pairs) {
    pairs = pairLines(lines).map((p) => ({
      ...p,
      leftHtml: safeHtml(p.leftHtml ?? (p.left ? hl(p.left.content, path) : "")),
      rightHtml: safeHtml(p.rightHtml ?? (p.right ? hl(p.right.content, path) : "")),
    }));
    pairCache.set(lines, pairs);
  }
  return pairs;
}

/** A line's highlighted, sanitised HTML, computed once per line. */
const lineHtmlCache = new WeakMap<DiffLine, string>();
function lineHtml(line: DiffLine, path: string): string {
  let html = lineHtmlCache.get(line);
  if (html === undefined) {
    html = safeHtml(hl(line.content, path));
    lineHtmlCache.set(line, html);
  }
  return html;
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

function cleanBody(raw: string): string {
  // Replace literal \n sequences with real newlines, then trim
  return raw.replace(/\\n/g, "\n").trim();
}

// ─── Body collapse ───────────────────────────────────────
const BODY_PREVIEW_LINES = 2;
const bodyExpanded = ref(false);

const bodyLines = computed(() => {
  if (!props.commitInfo?.body) return [];
  return cleanBody(props.commitInfo.body).split("\n");
});

const bodyNeedsCollapse = computed(() => bodyLines.value.length > BODY_PREVIEW_LINES);

const bodyPreview = computed(() =>
  bodyLines.value.slice(0, BODY_PREVIEW_LINES).join("\n"),
);

// Reset when commit changes
watch(() => props.commitHash, () => { bodyExpanded.value = false; });

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

/** Build initial set of expanded files from diffs already available at mount time */
function buildInitialExpanded(count: number): Set<number> {
  const s = new Set<number>();
  const autoExpand = Math.min(count, 5);
  for (let i = 0; i < autoExpand; i++) s.add(i);
  return s;
}

/** Set of expanded file indices — pre-seeded with whatever diffs are available at mount */
const expandedFiles = ref(buildInitialExpanded(props.diffs.length));

/** How many files to show in the list (grows on scroll) — capped at actual diff count */
const renderedFileCount = ref(Math.min(props.diffs.length, MAX_INITIAL_FILES));

function isExpanded(idx: number): boolean {
  return expandedFiles.value.has(idx);
}

function toggleFile(idx: number) {
  const s = new Set(expandedFiles.value);
  if (s.has(idx)) {
    s.delete(idx);
    // Hidden lines are not a selection ⌘⇧I should file.
    if (lineRange.range.value && parseRowGroup(lineRange.range.value.group).fileIdx === idx) lineRange.clear();
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

/** Truncated hunks per file, kept so their line arrays (the render caches'
 *  keys) stay the same objects from one render to the next. */
const truncatedCache = new WeakMap<GitDiff, GitDiff["hunks"]>();

/** Get hunks with truncation applied */
function truncatedHunks(idx: number) {
  const diff = props.diffs[idx];
  const cached = truncatedCache.get(diff);
  if (cached) return cached;
  if (!isFileTruncated(idx)) {
    truncatedCache.set(diff, diff.hunks);
    return diff.hunks;
  }

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
  truncatedCache.set(diff, result);
  return result;
}

// ─── Line selection → GitHub issue (#301) ───────────────
// Click a line number to select it, Shift+click another in the same hunk to
// extend; the selection is what "Create issue" (and ⌘⇧I) files.
const createIssue = inject(CREATE_ISSUE_KEY, null);
// Without the commit's details (not in the loaded log) there is nothing to
// file the lines against.
// Nor while another commit's diff is still on screen (the selected commit's
// is loading): its lines would be filed under the wrong commit.
const diffsAreThisCommits = computed(() => props.diffsHash === undefined || props.diffsHash === props.commitHash);
const canSelectLines = computed(() => !!createIssue?.available.value && !!props.commitInfo && diffsAreThisCommits.value);

/** `row`: inline rows; `old` / `new`: one column of the side-by-side pairs. */
type SelSide = RowSide;

const lineRange = useLineRange({
  dismiss: { keep: ".cdv-line-no, .cdv-issue-btn", scrollEl: () => contentEl.value },
});

function onLineNoClick(e: MouseEvent, fileIdx: number, hunkIdx: number, idx: number, side: SelSide) {
  if (canSelectLines.value) lineRange.pick(rowGroup(fileIdx, hunkIdx, side), idx, e.shiftKey);
}

// Issues no longer possible here (another origin, signed out): nothing to
// file the highlighted lines with.
watch(canSelectLines, (can) => {
  if (!can) lineRange.clear();
});

function isSelected(fileIdx: number, hunkIdx: number, idx: number, side: SelSide): boolean {
  return lineRange.isIn(rowGroup(fileIdx, hunkIdx, side), idx);
}

/** The selected range's file, hunk and column. */
const selectedAt = computed(() => {
  const r = lineRange.range.value;
  return r ? { ...parseRowGroup(r.group), lo: r.lo, hi: r.hi, pick: r } : null;
});

function isHunkSelected(fileIdx: number, hunkIdx: number): boolean {
  return selectedAt.value?.fileIdx === fileIdx && selectedAt.value?.hunkIdx === hunkIdx;
}

const selection = computed<DiffSelection | null>(() => {
  const s = selectedAt.value;
  const info = props.commitInfo;
  const diff = s ? props.diffs[s.fileIdx] : undefined;
  const hunk = s && diff ? truncatedHunks(s.fileIdx)[s.hunkIdx] : undefined;
  if (!s || !info || !diff || !hunk) return null;
  const lines =
    s.side === "row" ? hunk.lines.slice(s.lo, s.hi + 1) : rowsInColumn(pairsOf(hunk.lines, diff.path), s.side, s.lo, s.hi);
  if (lines.length === 0) return null;
  return {
    path: diff.path,
    ...(diff.oldPath ? { oldPath: diff.oldPath } : {}),
    // Picked in one column: link that version, whatever the lines' types.
    ...(s.side !== "row" ? { side: s.side } : {}),
    lines,
    source: { kind: "commit", hash: info.hash, hashFull: info.hashFull, parent: info.parents[0] ?? null },
    // Filed: the next ⌘⇧I is about something else, not these lines again —
    // unless other lines were picked since (they stay).
    onOpened: () => {
      if (lineRange.range.value === s.pick) lineRange.clear();
    },
  };
});

// Published for ⌘⇧I while issues can be created (#301).
useSelectionPublisher(createIssue, () => selection.value, () => lineRange.range.value);

function fileIssue() {
  const sel = selection.value;
  if (sel && createIssue) void createIssue.openFromSelection(sel);
}

/** The line numbers' tooltip, computed once rather than per cell. */
const pickTitle = computed(() => (canSelectLines.value ? t("createIssue.selectionHint") : undefined));

// Another commit, or another layout: row indices mean other lines. The same
// commit's diffs reloaded (a refresh) keep them.
watch(() => [props.commitHash, props.diffsHash, props.diffMode], lineRange.clear);

// Reset expansion and rendered count when diffs change (subsequent prop updates)
watch(
  () => props.diffs,
  () => {
    expandedFiles.value = buildInitialExpanded(props.diffs.length);
    renderedFileCount.value = Math.min(props.diffs.length, MAX_INITIAL_FILES);
    visibleFileIdx.value = 0;
  },
);

// ─── Scroll-spy: track which file is visible ────────────
const contentEl = ref<HTMLElement | null>(null);
const fileEls = ref<HTMLElement[]>([]);
const visibleFileIdx = ref(0);
const isManualScrolling = ref(false);

let observer: IntersectionObserver | null = null;
const visibleSet = new Map<number, number>();

function setupObserver() {
  teardownObserver();
  if (!contentEl.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      if (isManualScrolling.value) return;
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

watch(visibleFileIdx, (val) => {
  emit("update:visibleFileIdx", val);
});

watch(() => props.scrollToFileIdx, (idx) => {
  if (idx !== null && idx !== undefined) {
    scrollToFile(idx);
  }
});

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

onUnmounted(() => {
  teardownObserver();
});

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
  isManualScrolling.value = true;
  nextTick(() => {
    const el = fileEls.value[idx];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Clear manual scroll flag after a delay to allow smooth scroll to finish
      setTimeout(() => {
        isManualScrolling.value = false;
      }, 800);
    } else {
      isManualScrolling.value = false;
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
        <Avatar class="cdv-avatar" :name="commitInfo.author" :email="commitInfo.email" />
        <div class="cdv-commit-top-text">
          <div class="cdv-commit-subject">{{ commitInfo.message }}</div>
          <div class="cdv-commit-meta">
            <span class="cdv-author" :style="{ color: avatarStyle(commitInfo.email || commitInfo.author).color }">{{ commitInfo.author }}</span>
            <span class="cdv-meta-sep">&middot;</span>
            <span class="cdv-date">{{ formatDate(commitInfo.date) }}</span>
            <span class="cdv-meta-sep">&middot;</span>
            <span class="cdv-hash mono" :title="commitInfo.hashFull">{{ commitInfo.hash }}</span>
          </div>
        </div>
      </div>
      <!-- Row 2: body (if any) -->
      <div class="cdv-commit-body" v-if="commitInfo.body">
        <span class="cdv-body-text">{{ bodyExpanded || !bodyNeedsCollapse ? cleanBody(commitInfo.body) : bodyPreview }}</span>
        <button
          v-if="bodyNeedsCollapse"
          class="cdv-body-toggle"
          @click="bodyExpanded = !bodyExpanded"
        >{{ bodyExpanded ? '▲ moins' : `▼ +${bodyLines.length - BODY_PREVIEW_LINES} ligne${bodyLines.length - BODY_PREVIEW_LINES > 1 ? 's' : ''}` }}</button>
      </div>
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
              <div class="cdv-hunk-header mono">
                <span>{{ hunk.header }}</span>
                <button
                  v-if="selection && isHunkSelected(fileIdx - 1, hunkIdx)"
                  type="button"
                  class="cdv-issue-btn"
                  @click="fileIssue"
                >{{ t('createIssue.fromSelection') }}</button>
              </div>

              <!-- INLINE mode -->
              <table v-if="diffMode === 'inline'" class="cdv-table">
                <tbody>
                  <tr
                    v-for="(line, lineIdx) in hunk.lines"
                    :key="lineIdx"
                    class="cdv-line"
                    :class="[`cdv-line--${line.type}`, { 'cdv-line--selected': isSelected(fileIdx - 1, hunkIdx, lineIdx, 'row') }]"
                  >
                    <td
                      class="cdv-line-no mono"
                      :class="{ 'cdv-line-no--pick': canSelectLines }"
                      :title="pickTitle"
                      @mousedown="canSelectLines && preventShiftSelect($event)"
                      @click="onLineNoClick($event, fileIdx - 1, hunkIdx, lineIdx, 'row')"
                    >{{ line.oldLineNo ?? '' }}</td>
                    <td
                      class="cdv-line-no mono"
                      :class="{ 'cdv-line-no--pick': canSelectLines }"
                      :title="pickTitle"
                      @mousedown="canSelectLines && preventShiftSelect($event)"
                      @click="onLineNoClick($event, fileIdx - 1, hunkIdx, lineIdx, 'row')"
                    >{{ line.newLineNo ?? '' }}</td>
                    <td class="cdv-line-marker mono">
                      {{ line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ' }}
                    </td>
                    <td class="cdv-line-content mono">
                      <span v-html="lineHtml(line, diffs[fileIdx - 1].path) || '\u00a0'"></span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <!-- SIDE-BY-SIDE mode -->
              <table v-else class="cdv-table cdv-table--sbs">
                <tbody>
                  <tr
                    v-for="(pair, pairIdx) in pairsOf(hunk.lines, diffs[fileIdx - 1].path)"
                    :key="pairIdx"
                    class="cdv-line"
                  >
                    <td
                      class="cdv-line-no mono"
                      :class="[pair.left ? `cdv-sbs--${pair.left.type}` : 'cdv-sbs--empty', { 'cdv-line-no--pick': canSelectLines && pair.left, 'cdv-cell--selected': isSelected(fileIdx - 1, hunkIdx, pairIdx, 'old') }]"
                      :title="pair.left ? pickTitle : undefined"
                      @mousedown="canSelectLines && preventShiftSelect($event)"
                      @click="pair.left && onLineNoClick($event, fileIdx - 1, hunkIdx, pairIdx, 'old')"
                    >
                      {{ pair.left?.oldLineNo ?? '' }}
                    </td>
                    <td class="cdv-line-marker mono" :class="pair.left ? `cdv-sbs--${pair.left.type}` : 'cdv-sbs--empty'">
                      {{ pair.left?.type === 'delete' ? '-' : pair.left?.type === 'context' ? ' ' : '' }}
                    </td>
                    <td class="cdv-line-content mono cdv-sbs-content" :class="pair.left ? `cdv-sbs--${pair.left.type}` : 'cdv-sbs--empty'">
                      <span v-html="pair.leftHtml || '\u00a0'"></span>
                    </td>
                    <td class="cdv-sbs-gutter"></td>
                    <td
                      class="cdv-line-no mono"
                      :class="[pair.right ? `cdv-sbs--${pair.right.type}` : 'cdv-sbs--empty', { 'cdv-line-no--pick': canSelectLines && pair.right, 'cdv-cell--selected': isSelected(fileIdx - 1, hunkIdx, pairIdx, 'new') }]"
                      :title="pair.right ? pickTitle : undefined"
                      @mousedown="canSelectLines && preventShiftSelect($event)"
                      @click="pair.right && onLineNoClick($event, fileIdx - 1, hunkIdx, pairIdx, 'new')"
                    >
                      {{ pair.right?.newLineNo ?? '' }}
                    </td>
                    <td class="cdv-line-marker mono" :class="pair.right ? `cdv-sbs--${pair.right.type}` : 'cdv-sbs--empty'">
                      {{ pair.right?.type === 'add' ? '+' : pair.right?.type === 'context' ? ' ' : '' }}
                    </td>
                    <td class="cdv-line-content mono cdv-sbs-content" :class="pair.right ? `cdv-sbs--${pair.right.type}` : 'cdv-sbs--empty'">
                      <span v-html="pair.rightHtml || '\u00a0'"></span>
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
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  border: 1.5px solid currentColor;
}

.cdv-commit-top-text {
  flex: 1;
  min-width: 0;
}

.cdv-commit-subject {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--color-text);
  line-height: 1.4;
}

.cdv-commit-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.cdv-meta-sep {
  opacity: 0.4;
}

.cdv-author {
  font-weight: var(--font-medium);
}

.cdv-hash {
  font-size: var(--text-xs);
  color: var(--color-accent);
  background: var(--color-bg-tertiary);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.cdv-commit-body {
  font-size: var(--text-base);
  font-weight: var(--font-normal);
  color: var(--color-text-muted);
  line-height: 1.5;
  padding-left: 44px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cdv-body-text {
  margin-right: 44px;
}

.cdv-body-toggle {
  align-self: flex-start;
  font-size: var(--text-xs);
  color: var(--color-accent);
  background: none;
  padding: 0;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity var(--transition-fast);
}

.cdv-body-toggle:hover {
  opacity: 1;
}

.cdv-commit-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 44px;
}

.cdv-badge {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.cdv-badge--files {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.cdv-badge--add {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.cdv-badge--del {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.cdv-summary {
  font-size: var(--text-base);
  color: var(--color-text-muted);
}

.cdv-large-diff-hint {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  opacity: 0.6;
}

.cdv-stat {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
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
  transition: background var(--transition-fast);
}

.cdv-file-header:hover {
  background: var(--color-bg-tertiary);
}

.cdv-collapse-icon {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  transition: transform var(--transition-base);
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.cdv-collapse-icon--open {
  transform: rotate(90deg);
}

.cdv-file-name {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  flex-shrink: 0;
}

.cdv-file-path {
  font-size: var(--text-xs);
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 16px;
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--color-border);
}

/* Line selection for an issue (#301) */
.cdv-line-no--pick { cursor: pointer; }
.cdv-line-no--pick:hover { color: var(--color-accent); }
.cdv-line--selected > td,
.cdv-cell--selected {
  box-shadow: inset 0 0 0 9999px var(--color-accent-soft);
}
.cdv-issue-btn {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: var(--color-accent-text, #fff);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}
.cdv-issue-btn:hover { background: var(--color-accent-hover); }

.cdv-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.cdv-line {
  line-height: 1.5;
}

.cdv-line--context { background: var(--color-bg); }
.cdv-line--add { background: var(--color-success-soft); }
.cdv-line--delete { background: var(--color-danger-soft); }

.cdv-line-no {
  width: 44px;
  min-width: 44px;
  padding: 0 6px;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--color-text-subtle);
  opacity: 0.5;
  user-select: none;
  vertical-align: top;
  border-right: 1px solid var(--color-border);
}

.cdv-line-marker {
  width: 18px;
  min-width: 18px;
  padding: 0 3px;
  text-align: center;
  font-size: var(--text-base);
  color: var(--color-text-muted);
  user-select: none;
  vertical-align: top;
}

.cdv-line--add .cdv-line-marker { color: var(--color-success); font-weight: var(--font-bold); }
.cdv-line--delete .cdv-line-marker { color: var(--color-danger); font-weight: var(--font-bold); }

.cdv-line-content {
  vertical-align: top;
  padding: 0 10px;
  font-size: var(--text-base);
  /* Never truncate code: soft-wrap long lines, keep indentation. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
.cdv-sbs--delete { background: var(--color-danger-soft); }
.cdv-sbs--add { background: var(--color-success-soft); }
.cdv-sbs--empty { background: var(--color-bg-tertiary); opacity: 0.5; }

.cdv-sbs--delete.cdv-line-marker { color: var(--color-danger); font-weight: var(--font-bold); }
.cdv-sbs--add.cdv-line-marker { color: var(--color-success); font-weight: var(--font-bold); }
.cdv-sbs--delete.cdv-line-no { color: var(--color-danger); opacity: 0.7; }
.cdv-sbs--add.cdv-line-no { color: var(--color-success); opacity: 0.7; }

/* ─── Mode toggle ────────────────────────────────────── */
.cdv-mode-toggle {
  display: flex;
  gap: 2px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.cdv-mode-btn:hover {
  color: var(--color-text);
}

.cdv-mode-btn--active {
  background: var(--color-bg-secondary);
  color: var(--color-accent);
  box-shadow: var(--shadow-xs);
}

.cdv-truncated {
  padding: 8px 16px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  text-align: center;
  font-style: italic;
}

.cdv-load-more {
  padding: 12px 16px;
  font-size: var(--text-base);
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
