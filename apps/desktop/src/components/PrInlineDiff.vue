<script setup lang="ts">
/**
 * PrInlineDiff.vue
 *
 * Inline diff renderer for PR review — renders diff lines with:
 *  - Syntax highlighting
 *  - Comment threads anchored to specific lines (injected between rows)
 *  - "+" button on line-number hover to create new comments
 *  - Multi-line selection (drag line numbers) to create range comments
 *  - Code suggestion apply support
 */
import { ref, computed } from "vue";
import type { GitDiff, DiffLine, PrReviewComment } from "../utils/backend";
import { annotationsByLine as groupAnnotationsByLine, worstSeverity, type LineAnnotation } from "../composables/prAnnotations";
import PrCommentThread from "./PrCommentThread.vue";
import AiSparkle from "./AiSparkle.vue";
import { detectLanguage, highlightLine } from "../utils/highlight";
import { safeHtml } from "../composables/useSafeHtml";
import { useAIProvider } from "../composables/useAIProvider";
import { usePrHunkCritique, type HunkCritiqueResult } from "../composables/usePrHunkCritique";
import { useI18n } from "../composables/useI18n";
import { useVirtualRows } from "../composables/useVirtualRows";

const props = defineProps<{
  diff: GitDiff | null;
  filePath: string | null;
  /** All review comments for this file. */
  comments: PrReviewComment[];
  /** GitHub login of the authenticated user. */
  currentUser?: string;
  /** Number of comments already staged in the pending review draft. */
  reviewDraftCount?: number;
  cwd?: string;
  prNumber?: number;
  forgeName?: string;
  /** Merged CI + AI + static-flag annotations for this file (E1, v3.6.0). */
  annotations?: LineAnnotation[];
  /** Whether the active forge supports editing a comment (F2). Defaults to true. */
  canEditComments?: boolean;
  /** Whether the active forge supports deleting a comment (F2). Defaults to true. */
  canDeleteComments?: boolean;
}>();

interface CommentParams {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

const emit = defineEmits<{
  /** User wants to post an immediate comment (no review). */
  (e: "create-comment", params: CommentParams): void;
  /** User wants to stage a comment in the pending review draft. */
  (e: "add-to-review", params: CommentParams): void;
  (e: "reply-comment", inReplyToId: number, body: string): void;
  (e: "edit-comment", id: number, body: string): void;
  (e: "delete-comment", id: number): void;
  (e: "apply-suggestion", suggestion: string, startLine: number | null, endLine: number | null): void;
}>();

// ─── Syntax highlighting ─────────────────────────────────
const language = computed(() => props.filePath ? detectLanguage(props.filePath) : null);
function hl(content: string): string {
  return highlightLine(content, language.value);
}

// ─── AI hunk critique (Phase 1.3.1) ─────────────────────
const ai = useAIProvider();
const { isGenerating: isCritiquing, critique: critiqueHunk, lastError: critiqueAiError } = usePrHunkCritique();
const { locale, t } = useI18n();
/** Per-hunk cache: hunkIdx → result (or null while loading). */
const critiqueResults = ref<Record<number, HunkCritiqueResult | null>>({});
/** Which hunk is currently being analysed (only one at a time). */
const critiqueLoadingIdx = ref<number | null>(null);
/** Which hunk has its critique panel open. */
const critiqueOpenIdx = ref<number | null>(null);

async function requestHunkCritique(hunkIdx: number) {
  if (!props.diff || !props.filePath) return;
  const hunk = props.diff.hunks[hunkIdx];
  if (!hunk) return;

  // Toggle off if already shown.
  if (critiqueOpenIdx.value === hunkIdx && critiqueResults.value[hunkIdx]) {
    critiqueOpenIdx.value = null;
    return;
  }

  critiqueOpenIdx.value = hunkIdx;
  // Use the cached result if we have it.
  if (critiqueResults.value[hunkIdx]) return;

  critiqueLoadingIdx.value = hunkIdx;
  try {
    const res = await critiqueHunk(props.filePath, hunk, { locale: locale.value });
    critiqueResults.value = { ...critiqueResults.value, [hunkIdx]: res };
  } catch {
    // surfaced via critiqueAiError
  } finally {
    if (critiqueLoadingIdx.value === hunkIdx) critiqueLoadingIdx.value = null;
  }
}

function dismissCritique() {
  critiqueOpenIdx.value = null;
}

function verdictClass(v: HunkCritiqueResult["verdict"]): string {
  return `pid-critique--${v}`;
}

function verdictIcon(v: HunkCritiqueResult["verdict"]): string {
  switch (v) {
    case "ok":         return "✓";
    case "nit":        return "·";
    case "suggestion": return "💡";
    case "risk":       return "⚠";
  }
}

// ─── Thread grouping ─────────────────────────────────────
/**
 * Group comments into threads keyed by "path:line:side".
 * Replies are nested under their root comment.
 * A thread is rendered BELOW the line it's anchored to.
 */
interface Thread {
  key: string;       // path:line:side
  path: string;
  line: number;      // line number on the relevant side
  side: "LEFT" | "RIGHT";
  comments: PrReviewComment[];
}

const threads = computed<Thread[]>(() => {
  const roots = props.comments.filter((c) => !c.in_reply_to_id);
  return roots.map((root) => {
    const replies = props.comments.filter((c) => c.in_reply_to_id === root.id);
    const side = root.side ?? "RIGHT";
    const line = side === "RIGHT"
      ? (root.line ?? root.original_line ?? 0)
      : (root.original_line ?? root.line ?? 0);
    return {
      key: `${root.path}:${line}:${side}`,
      path: root.path,
      line,
      side,
      comments: [root, ...replies].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    };
  });
});

/** Get threads for a given line (matched by newLineNo for RIGHT, oldLineNo for LEFT). */
function threadsForLine(line: DiffLine): Thread[] {
  return threads.value.filter((t) => {
    if (t.side === "RIGHT") return t.line === line.newLineNo;
    if (t.side === "LEFT") return t.line === line.oldLineNo;
    return false;
  });
}

// ─── Line annotations (E1, v3.6.0 — CI + AI + static, unified) ──────────
// CI annotations were previously matched new-side-only (`newLineNo`), since
// GitHub/GitLab/Bitbucket check-runs are always anchored on the head commit.
// The shared model supports both sides (LEFT for AI/static findings on
// removed lines); CI-only behavior stays byte-identical (still RIGHT-only)
// since `fromCIAnnotation` always sets `side: "RIGHT"`.
const ANN_ICONS: Record<string, string> = {
  failure: "❌",
  risk: "❌",
  warning: "⚠",
  suggestion: "⚠",
  notice: "ℹ",
  nit: "ℹ",
};

const mergedAnnotationsByLine = computed(() => groupAnnotationsByLine(props.annotations ?? []));

function annotationsForLine(line: DiffLine): LineAnnotation[] {
  const anns: LineAnnotation[] = [];
  if (line.newLineNo != null) {
    anns.push(...(mergedAnnotationsByLine.value.get(`RIGHT:${line.newLineNo}`) ?? []));
  }
  // Delete lines have no RIGHT side — this is purely additive (previously
  // always matched nothing here, since CI annotations are RIGHT-only).
  if (line.oldLineNo != null && line.type === "delete") {
    anns.push(...(mergedAnnotationsByLine.value.get(`LEFT:${line.oldLineNo}`) ?? []));
  }
  return anns;
}

/** Worst severity wins for the gutter icon. */
function annotationLevel(anns: LineAnnotation[]): string {
  return worstSeverity(anns);
}

// ─── Compose new comment ─────────────────────────────────
interface ComposeLine {
  hunkIdx: number;
  lineIdx: number;
  line: number;
  side: "LEFT" | "RIGHT";
}

const composeLine = ref<ComposeLine | null>(null);
const composeText = ref("");

// ─── Code suggestion editor (v2.13) ──────────────────────
/**
 * Suggestion state — reuses ComposeLine to track position.
 * `suggestText` is pre-filled with the current line content;
 * the user edits the proposed replacement. On submit the text is
 * wrapped in a GitHub ` ```suggestion ``` ` block and staged as a
 * pending review comment (never a direct post).
 */
const suggestLine = ref<ComposeLine | null>(null);
const suggestText = ref("");

function openSuggest(hunkIdx: number, lineIdx: number, dl: DiffLine) {
  // Suggestions only make sense on the new-file side.
  if (dl.type === "delete") return;
  const line = dl.newLineNo ?? 0;
  suggestLine.value = { hunkIdx, lineIdx, line, side: "RIGHT" };
  // Pre-fill with the existing line content (strip leading marker spaces).
  suggestText.value = dl.content.replace(/^\+?/, "");
  composeLine.value = null; // close regular compose if open
  composeText.value = "";
}

function closeSuggest() {
  suggestLine.value = null;
  suggestText.value = "";
}

function submitSuggest() {
  if (!suggestLine.value || !props.filePath) return;
  const { line } = suggestLine.value;
  const suggestionBlock = `\`\`\`suggestion\n${suggestText.value}\n\`\`\``;
  emit("add-to-review", {
    path: props.filePath,
    line,
    side: "RIGHT",
    body: suggestionBlock,
  });
  closeSuggest();
}

function isSuggestAnchoredAt(dl: DiffLine): boolean {
  if (!suggestLine.value) return false;
  return suggestLine.value.line === dl.newLineNo && dl.type !== "delete";
}

// Multi-line selection
const selectionStart = ref<{ line: number; side: "LEFT" | "RIGHT" } | null>(null);
const selectionEnd = ref<{ line: number; side: "LEFT" | "RIGHT" } | null>(null);
const isDragging = ref(false);

function openCompose(hunkIdx: number, lineIdx: number, dl: DiffLine) {
  const side: "LEFT" | "RIGHT" = dl.type === "delete" ? "LEFT" : "RIGHT";
  const line = side === "RIGHT" ? (dl.newLineNo ?? 0) : (dl.oldLineNo ?? 0);
  composeLine.value = { hunkIdx, lineIdx, line, side };
  composeText.value = "";
  selectionStart.value = null;
  selectionEnd.value = null;
}

function closeCompose() {
  composeLine.value = null;
  composeText.value = "";
  selectionStart.value = null;
  selectionEnd.value = null;
}

function buildComposeParams(): CommentParams | null {
  if (!composeLine.value || !composeText.value.trim() || !props.filePath) return null;
  const body = composeText.value.trim();
  const { line, side } = composeLine.value;
  const base: CommentParams = { path: props.filePath, line, side, body };
  if (selectionStart.value && selectionStart.value.line !== line) {
    return {
      ...base,
      start_line: Math.min(selectionStart.value.line, line),
      start_side: selectionStart.value.side,
    };
  }
  return base;
}

function submitCompose() {
  const params = buildComposeParams();
  if (!params) return;
  emit("create-comment", params);
  closeCompose();
}

function submitToReview() {
  const params = buildComposeParams();
  if (!params) return;
  emit("add-to-review", params);
  closeCompose();
}

function isComposeAnchoredAt(dl: DiffLine): boolean {
  if (!composeLine.value) return false;
  const side: "LEFT" | "RIGHT" = dl.type === "delete" ? "LEFT" : "RIGHT";
  const lineNo = side === "RIGHT" ? dl.newLineNo : dl.oldLineNo;
  return composeLine.value.line === lineNo && composeLine.value.side === side;
}

// ─── Thread reply/edit/delete handlers ──────────────────
function handleReply(thread: Thread, body: string) {
  const rootId = thread.comments[0].id;
  emit("reply-comment", rootId, body);
}

function handleEdit(id: number, body: string) {
  emit("edit-comment", id, body);
}

function handleDelete(id: number) {
  emit("delete-comment", id);
}

function handleApplySuggestion(suggestion: string, startLine: number | null, endLine: number | null) {
  emit("apply-suggestion", suggestion, startLine, endLine);
}

// ─── Flat row model (A2) ──────────────────────────────────
// Threads, the critique panel, and the compose/suggest boxes are normally
// injected *between* hunk/line rows by the template above. Virtualization
// needs every one of them to be an addressable row so the virtualizer can
// measure and position it — so the diff is also expressed as a flat
// `rows: DiffRow[]` list, in the exact order the full-DOM template renders.
export type DiffRow =
  | { kind: "hunk-header"; hunkIdx: number }
  | { kind: "critique"; hunkIdx: number }
  | { kind: "line"; hunkIdx: number; lineIdx: number; dl: DiffLine }
  | { kind: "thread"; hunkIdx: number; lineIdx: number; dl: DiffLine; thread: Thread }
  | { kind: "compose"; hunkIdx: number; lineIdx: number; dl: DiffLine }
  | { kind: "suggest"; hunkIdx: number; lineIdx: number; dl: DiffLine };

function critiquePanelVisible(hunkIdx: number): boolean {
  return (
    critiqueOpenIdx.value === hunkIdx &&
    !!(critiqueResults.value[hunkIdx] || critiqueLoadingIdx.value === hunkIdx || critiqueAiError.value)
  );
}

const rows = computed<DiffRow[]>(() => {
  const out: DiffRow[] = [];
  if (!props.diff) return out;
  props.diff.hunks.forEach((hunk, hunkIdx) => {
    out.push({ kind: "hunk-header", hunkIdx });
    if (critiquePanelVisible(hunkIdx)) out.push({ kind: "critique", hunkIdx });
    hunk.lines.forEach((dl, lineIdx) => {
      out.push({ kind: "line", hunkIdx, lineIdx, dl });
      for (const thread of threadsForLine(dl)) {
        out.push({ kind: "thread", hunkIdx, lineIdx, dl, thread });
      }
      if (isComposeAnchoredAt(dl)) out.push({ kind: "compose", hunkIdx, lineIdx, dl });
      if (isSuggestAnchoredAt(dl)) out.push({ kind: "suggest", hunkIdx, lineIdx, dl });
    });
  });
  return out;
});

/** True for the first row belonging to a given hunk (drives the "boxed hunk"
 *  top border/corner once the per-hunk wrapper div is gone, see A2 CSS). */
function isHunkStart(idx: number): boolean {
  const row = rows.value[idx];
  return idx === 0 || rows.value[idx - 1]?.hunkIdx !== row.hunkIdx;
}

/** True for the last row belonging to a given hunk. */
function isHunkEnd(idx: number): boolean {
  const row = rows.value[idx];
  return idx === rows.value.length - 1 || rows.value[idx + 1]?.hunkIdx !== row.hunkIdx;
}

function rowKey(row: DiffRow, idx: number): string {
  if (row.kind === "hunk-header" || row.kind === "critique") return `${row.kind}:${row.hunkIdx}`;
  if (row.kind === "thread") return `thread:${row.thread.key}:${idx}`;
  return `${row.kind}:${row.hunkIdx}:${row.lineIdx}`;
}

// ─── Virtualization (A2) ───────────────────────────────────
// Full DOM under the threshold (native find/select stay intact); virtualized
// above it so a huge single-hunk file doesn't render thousands of live rows.
const ROW_VIRTUALIZE_THRESHOLD = 300;
const isVirtual = computed(() => rows.value.length >= ROW_VIRTUALIZE_THRESHOLD);
const scrollContainerRef = ref<HTMLElement | null>(null);

const ROW_ESTIMATE_SIZE: Record<DiffRow["kind"], number> = {
  "hunk-header": 24,
  critique: 60,
  line: 20,
  thread: 110,
  compose: 160,
  suggest: 180,
};

const { virtualizer, virtualItems, totalSize, measure } = useVirtualRows({
  count: computed(() => rows.value.length),
  getScrollElement: () => scrollContainerRef.value,
  estimateSize: (index: number) => ROW_ESTIMATE_SIZE[rows.value[index]?.kind ?? "line"],
  overscan: 20,
});

/** Pairs each virtual item with its already-discriminated `DiffRow` — lets
 *  the virtualized template branch on `row.kind` with the same type
 *  narrowing the non-virtual `v-for="(row, idx) in rows"` branch gets
 *  (indexing `rows[vr.index]` fresh on every reference does not narrow). */
const virtualRowsView = computed(() =>
  virtualItems.value.map((vr) => ({ vr, row: rows.value[vr.index] })),
);

function vrStyle(vr: { start: number; size: number }) {
  return {
    position: "absolute" as const,
    top: 0,
    left: 0,
    width: "100%",
    height: vr.size + "px",
    overflow: "visible" as const,
    transform: "translateY(" + vr.start + "px)",
  };
}

/** Keyboard-nav cursor (B1) — index into `rows`. Kept here (not in the host)
 *  so `scrollToHunk`/`scrollToLine` can highlight/scroll in one call. */
const currentRowIdx = ref(0);

function scrollRowIntoView(idx: number) {
  if (isVirtual.value) {
    virtualizer.value?.scrollToIndex(idx, { align: "auto" });
    return;
  }
  const el = (scrollContainerRef.value ?? document).querySelector?.(`[data-row-index="${idx}"]`);
  el?.scrollIntoView?.({ block: "nearest" });
}

/** Scroll to (and select) the first row of hunk `hunkIdx`. */
function scrollToHunk(hunkIdx: number) {
  const idx = rows.value.findIndex((r) => r.kind === "hunk-header" && r.hunkIdx === hunkIdx);
  if (idx === -1) return;
  currentRowIdx.value = idx;
  scrollRowIntoView(idx);
}

/** Scroll to (and select) an arbitrary row by its index in `rows`. */
function scrollToLine(rowIdx: number) {
  if (rowIdx < 0 || rowIdx >= rows.value.length) return;
  currentRowIdx.value = rowIdx;
  scrollRowIntoView(rowIdx);
}

/** B1 `C` shortcut — open the compose box anchored at the first line of the
 *  given hunk (the "current hunk" the keyboard cursor is on). */
function openComposeAtHunk(hunkIdx: number) {
  const hunk = props.diff?.hunks[hunkIdx];
  if (!hunk || !hunk.lines.length) return;
  openCompose(hunkIdx, 0, hunk.lines[0]);
}

defineExpose({ scrollToHunk, scrollToLine, openComposeAtHunk, rows, currentRowIdx });
</script>

<template>
  <div class="pid-root">
    <div v-if="!diff || !diff.hunks.length" class="pid-empty">
      Aucun diff disponible.
    </div>
    <!-- A2: full DOM under the virtualization threshold — keeps native
         Cmd+F / text-select working, identical markup to the virtual path. -->
    <div v-else-if="!isVirtual" class="pid-rows">
      <template v-for="(row, idx) in rows" :key="rowKey(row, idx)">
        <!-- Hunk header -->
        <div
          v-if="row.kind === 'hunk-header'"
          class="pid-hunk-header mono pid-rowbox pid-rowbox--start"
          :class="{ 'pid-rowbox--end': isHunkEnd(idx) }"
          :data-row-index="idx"
        >
          <span class="pid-hunk-header-text">{{ diff.hunks[row.hunkIdx].header }}</span>
          <button
            v-if="ai.isAvailable.value"
            class="btn btn--ai pid-hunk-ai"
            :class="{ 'pid-hunk-ai--active': critiqueOpenIdx === row.hunkIdx }"
            :disabled="critiqueLoadingIdx === row.hunkIdx"
            :title="t('prInline.aiCritiqueTooltip')"
            @click="requestHunkCritique(row.hunkIdx)"
          >
            <span v-if="critiqueLoadingIdx === row.hunkIdx">…</span>
            <span v-else class="pid-ai-label">
              <AiSparkle :size="13" />
              {{ t('prInline.aiCritiqueButton') }}
            </span>
          </button>
        </div>

        <!-- AI critique panel -->
        <div
          v-else-if="row.kind === 'critique'"
          class="pid-critique pid-rowbox"
          :class="[critiqueResults[row.hunkIdx] ? verdictClass(critiqueResults[row.hunkIdx]!.verdict) : '', { 'pid-rowbox--end': isHunkEnd(idx) }]"
          role="status"
          aria-live="polite"
          :data-row-index="idx"
        >
          <span class="pid-critique-icon">
            <template v-if="critiqueResults[row.hunkIdx]">{{ verdictIcon(critiqueResults[row.hunkIdx]!.verdict) }}</template>
            <AiSparkle v-else :size="14" />
          </span>
          <span class="pid-critique-body">
            <span v-if="critiqueAiError && !critiqueResults[row.hunkIdx]" class="pid-critique-error">{{ critiqueAiError }}</span>
            <span v-else-if="critiqueLoadingIdx === row.hunkIdx && !critiqueResults[row.hunkIdx]">
              {{ t('prInline.aiCritiqueAnalyzing') }}
            </span>
            <template v-else-if="critiqueResults[row.hunkIdx]">
              <span class="pid-critique-verdict">{{ critiqueResults[row.hunkIdx]!.verdict }}</span>
              <span class="pid-critique-summary">{{ critiqueResults[row.hunkIdx]!.summary }}</span>
            </template>
          </span>
          <button
            v-if="critiqueLoadingIdx !== row.hunkIdx"
            class="pid-critique-close"
            @click="dismissCritique"
            aria-label="Close"
          >✕</button>
        </div>

        <!-- Diff line -->
        <div
          v-else-if="row.kind === 'line'"
          class="pid-row pid-rowbox"
          :class="{
            'pid-row--add': row.dl.type === 'add',
            'pid-row--del': row.dl.type === 'delete',
            'pid-row--ctx': row.dl.type === 'context',
            'pid-row--annotated': annotationsForLine(row.dl).length > 0,
            'pid-rowbox--start': isHunkStart(idx),
            'pid-rowbox--end': isHunkEnd(idx),
          }"
          :data-row-index="idx"
        >
          <!-- CI annotation gutter icon + hover tooltip (v2.18) -->
          <div v-if="annotationsForLine(row.dl).length" class="pid-ann">
            <span
              class="pid-ann-icon"
              :class="`pid-ann-icon--${annotationLevel(annotationsForLine(row.dl))}`"
            >{{ ANN_ICONS[annotationLevel(annotationsForLine(row.dl))] }}</span>
            <div class="pid-ann-tip">
              <div
                v-for="(a, ai) in annotationsForLine(row.dl)"
                :key="ai"
                class="pid-ann-tip-item"
              >
                <div class="pid-ann-tip-head">
                  <span>{{ ANN_ICONS[a.severity] }}</span>
                  <span class="pid-ann-tip-title">{{ a.title || a.checkName }}</span>
                  <span v-if="a.confidence != null" class="pid-ann-tip-confidence">{{ a.confidence }}%</span>
                </div>
                <div v-if="a.message" class="pid-ann-tip-msg">{{ a.message }}</div>
                <div class="pid-ann-tip-src">{{ a.checkName || a.source }}</div>
              </div>
            </div>
          </div>
          <!-- Old line number -->
          <div
            class="pid-lno mono"
            :class="{ 'pid-lno--clickable': row.dl.type !== 'add' }"
            @click="row.dl.type !== 'add' && openCompose(row.hunkIdx, row.lineIdx, row.dl)"
            :title="row.dl.type !== 'add' ? 'Ajouter un commentaire' : undefined"
          >
            <span class="pid-lno-num">{{ row.dl.oldLineNo ?? '' }}</span>
            <span class="pid-lno-icon">+</span>
          </div>
          <!-- New line number -->
          <div
            class="pid-lno mono"
            :class="{ 'pid-lno--clickable': row.dl.type !== 'delete' }"
            @click="row.dl.type !== 'delete' && openCompose(row.hunkIdx, row.lineIdx, row.dl)"
            :title="row.dl.type !== 'delete' ? 'Ajouter un commentaire' : undefined"
          >
            <span class="pid-lno-num">{{ row.dl.newLineNo ?? '' }}</span>
            <span class="pid-lno-icon">+</span>
          </div>
          <!-- Marker -->
          <div class="pid-marker mono">
            {{ row.dl.type === 'add' ? '+' : row.dl.type === 'delete' ? '-' : ' ' }}
          </div>
          <!-- Content -->
          <div class="pid-content mono" v-html="safeHtml(hl(row.dl.content)) || '&nbsp;'" />
          <!-- Suggest button (v2.13) — visible on hover for add/context lines -->
          <button
            v-if="row.dl.type !== 'delete'"
            class="pid-suggest-btn"
            :title="t('pr.inline.suggestTooltip')"
            @click.stop="openSuggest(row.hunkIdx, row.lineIdx, row.dl)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>

        <!-- Comment thread anchored to this line -->
        <div
          v-else-if="row.kind === 'thread'"
          class="pid-thread-row pid-rowbox"
          :class="{ 'pid-rowbox--end': isHunkEnd(idx) }"
          :data-row-index="idx"
        >
          <div class="pid-thread-gutter" />
          <div class="pid-thread-body">
            <PrCommentThread
              :comments="row.thread.comments"
              :current-user="currentUser"
              :cwd="cwd"
              :pr-number="prNumber"
              :forge-name="forgeName"
              :can-edit="props.canEditComments"
              :can-delete="props.canDeleteComments"
              @reply="(body) => handleReply(row.thread, body)"
              @edit="handleEdit"
              @delete="handleDelete"
              @apply-suggestion="handleApplySuggestion"
            />
          </div>
        </div>

        <!-- Compose box anchored to this line -->
        <div
          v-else-if="row.kind === 'compose'"
          class="pid-thread-row pid-compose-row pid-rowbox"
          :class="{ 'pid-rowbox--end': isHunkEnd(idx) }"
          :data-row-index="idx"
        >
          <div class="pid-thread-gutter" />
          <div class="pid-thread-body">
            <div class="pid-compose">
              <textarea
                v-model="composeText"
                class="pid-textarea"
                :placeholder="t('pr.inline.composePlaceholder')"
                rows="3"
                autofocus
                @keydown.ctrl.enter.prevent="submitCompose"
                @keydown.meta.enter.prevent="submitCompose"
                @keydown.escape="closeCompose"
              />
              <div class="pid-compose-actions">
                <button class="pid-cancel-btn" @click="closeCompose">{{ t('pr.inline.cancel') }}</button>
                <button
                  class="pid-review-btn"
                  :disabled="!composeText.trim()"
                  @click="submitToReview"
                  :title="reviewDraftCount ? t('pr.inline.addToReviewPending', reviewDraftCount) : t('pr.inline.addToReview')"
                >
                  {{ reviewDraftCount ? t('pr.inline.reviewBtnCount', reviewDraftCount) : t('pr.inline.reviewBtn') }}
                </button>
                <button
                  class="pid-submit-btn"
                  :disabled="!composeText.trim()"
                  @click="submitCompose"
                >{{ t('pr.inline.commentBtn') }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Suggestion editor (v2.13) -->
        <div
          v-else-if="row.kind === 'suggest'"
          class="pid-thread-row pid-suggest-row pid-rowbox"
          :class="{ 'pid-rowbox--end': isHunkEnd(idx) }"
          :data-row-index="idx"
        >
          <div class="pid-thread-gutter" />
          <div class="pid-thread-body">
            <div class="pid-suggest">
              <div class="pid-suggest-header">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                  <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" stroke-linejoin="round"/>
                </svg>
                {{ t('pr.inline.suggestTitle') }}
                <span class="pid-suggest-hint">{{ t('pr.inline.suggestHint') }}</span>
              </div>
              <div class="pid-suggest-preview">
                <span class="pid-suggest-fence">```suggestion</span>
                <textarea
                  v-model="suggestText"
                  class="pid-textarea pid-suggest-textarea mono"
                  rows="3"
                  autofocus
                  @keydown.ctrl.enter.prevent="submitSuggest"
                  @keydown.meta.enter.prevent="submitSuggest"
                  @keydown.escape="closeSuggest"
                />
                <span class="pid-suggest-fence">```</span>
              </div>
              <div class="pid-compose-actions">
                <button class="pid-cancel-btn" @click="closeSuggest">{{ t('pr.inline.cancel') }}</button>
                <button
                  class="pid-review-btn"
                  @click="submitSuggest"
                  :title="reviewDraftCount ? t('pr.inline.addToReviewPending', reviewDraftCount) : t('pr.inline.addToReview')"
                >
                  {{ reviewDraftCount ? t('pr.inline.reviewBtnCount', reviewDraftCount) : t('pr.inline.suggestAddToReview') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- A2: virtualized above the threshold — same row markup, only the
         positioning differs (absolute + translateY instead of normal flow). -->
    <div v-else ref="scrollContainerRef" class="pid-rows pid-rows--virtual">
      <div :style="{ height: totalSize + 'px', position: 'relative', width: '100%' }">
        <div
          v-for="{ vr, row } in virtualRowsView"
          :key="'' + vr.key"
          :data-row-index="vr.index"
          :ref="(el) => measure(el as Element)"
          :style="vrStyle(vr)"
        >
          <template v-if="row.kind === 'hunk-header'">
            <div
              class="pid-hunk-header mono pid-rowbox pid-rowbox--start"
              :class="{ 'pid-rowbox--end': isHunkEnd(vr.index) }"
            >
              <span class="pid-hunk-header-text">{{ diff.hunks[row.hunkIdx].header }}</span>
              <button
                v-if="ai.isAvailable.value"
                class="btn btn--ai pid-hunk-ai"
                :class="{ 'pid-hunk-ai--active': critiqueOpenIdx === row.hunkIdx }"
                :disabled="critiqueLoadingIdx === row.hunkIdx"
                :title="t('prInline.aiCritiqueTooltip')"
                @click="requestHunkCritique(row.hunkIdx)"
              >
                <span v-if="critiqueLoadingIdx === row.hunkIdx">…</span>
                <span v-else class="pid-ai-label">
                  <AiSparkle :size="13" />
                  {{ t('prInline.aiCritiqueButton') }}
                </span>
              </button>
            </div>
          </template>
          <template v-else-if="row.kind === 'critique'">
            <div
              class="pid-critique pid-rowbox"
              :class="[critiqueResults[row.hunkIdx] ? verdictClass(critiqueResults[row.hunkIdx]!.verdict) : '', { 'pid-rowbox--end': isHunkEnd(vr.index) }]"
              role="status"
              aria-live="polite"
            >
              <span class="pid-critique-icon">
                <template v-if="critiqueResults[row.hunkIdx]">{{ verdictIcon(critiqueResults[row.hunkIdx]!.verdict) }}</template>
                <AiSparkle v-else :size="14" />
              </span>
              <span class="pid-critique-body">
                <span v-if="critiqueAiError && !critiqueResults[row.hunkIdx]" class="pid-critique-error">{{ critiqueAiError }}</span>
                <span v-else-if="critiqueLoadingIdx === row.hunkIdx && !critiqueResults[row.hunkIdx]">
                  {{ t('prInline.aiCritiqueAnalyzing') }}
                </span>
                <template v-else-if="critiqueResults[row.hunkIdx]">
                  <span class="pid-critique-verdict">{{ critiqueResults[row.hunkIdx]!.verdict }}</span>
                  <span class="pid-critique-summary">{{ critiqueResults[row.hunkIdx]!.summary }}</span>
                </template>
              </span>
              <button
                v-if="critiqueLoadingIdx !== row.hunkIdx"
                class="pid-critique-close"
                @click="dismissCritique"
                aria-label="Close"
              >✕</button>
            </div>
          </template>
          <template v-else-if="row.kind === 'line'">
            <div
              class="pid-row pid-rowbox"
              :class="{
                'pid-row--add': row.dl.type === 'add',
                'pid-row--del': row.dl.type === 'delete',
                'pid-row--ctx': row.dl.type === 'context',
                'pid-row--annotated': annotationsForLine(row.dl).length > 0,
                'pid-rowbox--start': isHunkStart(vr.index),
                'pid-rowbox--end': isHunkEnd(vr.index),
              }"
            >
              <div v-if="annotationsForLine(row.dl).length" class="pid-ann">
                <span
                  class="pid-ann-icon"
                  :class="`pid-ann-icon--${annotationLevel(annotationsForLine(row.dl))}`"
                >{{ ANN_ICONS[annotationLevel(annotationsForLine(row.dl))] }}</span>
                <div class="pid-ann-tip">
                  <div
                    v-for="(a, ai) in annotationsForLine(row.dl)"
                    :key="ai"
                    class="pid-ann-tip-item"
                  >
                    <div class="pid-ann-tip-head">
                      <span>{{ ANN_ICONS[a.severity] }}</span>
                      <span class="pid-ann-tip-title">{{ a.title || a.checkName }}</span>
                      <span v-if="a.confidence != null" class="pid-ann-tip-confidence">{{ a.confidence }}%</span>
                    </div>
                    <div v-if="a.message" class="pid-ann-tip-msg">{{ a.message }}</div>
                    <div class="pid-ann-tip-src">{{ a.checkName || a.source }}</div>
                  </div>
                </div>
              </div>
              <div
                class="pid-lno mono"
                :class="{ 'pid-lno--clickable': row.dl.type !== 'add' }"
                @click="row.dl.type !== 'add' && openCompose(row.hunkIdx, row.lineIdx, row.dl)"
                :title="row.dl.type !== 'add' ? 'Ajouter un commentaire' : undefined"
              >
                <span class="pid-lno-num">{{ row.dl.oldLineNo ?? '' }}</span>
                <span class="pid-lno-icon">+</span>
              </div>
              <div
                class="pid-lno mono"
                :class="{ 'pid-lno--clickable': row.dl.type !== 'delete' }"
                @click="row.dl.type !== 'delete' && openCompose(row.hunkIdx, row.lineIdx, row.dl)"
                :title="row.dl.type !== 'delete' ? 'Ajouter un commentaire' : undefined"
              >
                <span class="pid-lno-num">{{ row.dl.newLineNo ?? '' }}</span>
                <span class="pid-lno-icon">+</span>
              </div>
              <div class="pid-marker mono">
                {{ row.dl.type === 'add' ? '+' : row.dl.type === 'delete' ? '-' : ' ' }}
              </div>
              <div class="pid-content mono" v-html="safeHtml(hl(row.dl.content)) || '&nbsp;'" />
              <button
                v-if="row.dl.type !== 'delete'"
                class="pid-suggest-btn"
                :title="t('pr.inline.suggestTooltip')"
                @click.stop="openSuggest(row.hunkIdx, row.lineIdx, row.dl)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                  <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </template>
          <template v-else-if="row.kind === 'thread'">
            <div class="pid-thread-row pid-rowbox" :class="{ 'pid-rowbox--end': isHunkEnd(vr.index) }">
              <div class="pid-thread-gutter" />
              <div class="pid-thread-body">
                <PrCommentThread
                  :comments="row.thread.comments"
                  :current-user="currentUser"
                  :cwd="cwd"
                  :pr-number="prNumber"
                  :forge-name="forgeName"
                  :can-edit="props.canEditComments"
                  :can-delete="props.canDeleteComments"
                  @reply="(body) => handleReply(row.thread, body)"
                  @edit="handleEdit"
                  @delete="handleDelete"
                  @apply-suggestion="handleApplySuggestion"
                />
              </div>
            </div>
          </template>
          <template v-else-if="row.kind === 'compose'">
            <div class="pid-thread-row pid-compose-row pid-rowbox" :class="{ 'pid-rowbox--end': isHunkEnd(vr.index) }">
              <div class="pid-thread-gutter" />
              <div class="pid-thread-body">
                <div class="pid-compose">
                  <textarea
                    v-model="composeText"
                    class="pid-textarea"
                    :placeholder="t('pr.inline.composePlaceholder')"
                    rows="3"
                    autofocus
                    @keydown.ctrl.enter.prevent="submitCompose"
                    @keydown.meta.enter.prevent="submitCompose"
                    @keydown.escape="closeCompose"
                  />
                  <div class="pid-compose-actions">
                    <button class="pid-cancel-btn" @click="closeCompose">{{ t('pr.inline.cancel') }}</button>
                    <button
                      class="pid-review-btn"
                      :disabled="!composeText.trim()"
                      @click="submitToReview"
                      :title="reviewDraftCount ? t('pr.inline.addToReviewPending', reviewDraftCount) : t('pr.inline.addToReview')"
                    >
                      {{ reviewDraftCount ? t('pr.inline.reviewBtnCount', reviewDraftCount) : t('pr.inline.reviewBtn') }}
                    </button>
                    <button
                      class="pid-submit-btn"
                      :disabled="!composeText.trim()"
                      @click="submitCompose"
                    >{{ t('pr.inline.commentBtn') }}</button>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template v-else-if="row.kind === 'suggest'">
            <div class="pid-thread-row pid-suggest-row pid-rowbox" :class="{ 'pid-rowbox--end': isHunkEnd(vr.index) }">
              <div class="pid-thread-gutter" />
              <div class="pid-thread-body">
                <div class="pid-suggest">
                  <div class="pid-suggest-header">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                      <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" stroke-linejoin="round"/>
                    </svg>
                    {{ t('pr.inline.suggestTitle') }}
                    <span class="pid-suggest-hint">{{ t('pr.inline.suggestHint') }}</span>
                  </div>
                  <div class="pid-suggest-preview">
                    <span class="pid-suggest-fence">```suggestion</span>
                    <textarea
                      v-model="suggestText"
                      class="pid-textarea pid-suggest-textarea mono"
                      rows="3"
                      autofocus
                      @keydown.ctrl.enter.prevent="submitSuggest"
                      @keydown.meta.enter.prevent="submitSuggest"
                      @keydown.escape="closeSuggest"
                    />
                    <span class="pid-suggest-fence">```</span>
                  </div>
                  <div class="pid-compose-actions">
                    <button class="pid-cancel-btn" @click="closeSuggest">{{ t('pr.inline.cancel') }}</button>
                    <button
                      class="pid-review-btn"
                      @click="submitSuggest"
                      :title="reviewDraftCount ? t('pr.inline.addToReviewPending', reviewDraftCount) : t('pr.inline.addToReview')"
                    >
                      {{ reviewDraftCount ? t('pr.inline.reviewBtnCount', reviewDraftCount) : t('pr.inline.suggestAddToReview') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pid-root {
  font-size: 12px;
  overflow-x: auto;
  background: var(--color-bg);
}

.pid-empty {
  padding: 24px;
  color: var(--color-text-muted);
  text-align: center;
}

/* A2: each hunk used to be wrapped in a single `.pid-hunk` box (border +
   radius + overflow:hidden). Flattening to a per-row virtualizable list
   means there's no wrapper element anymore — every row instead carries
   `.pid-rowbox` (side borders) plus `--start`/`--end` on the first/last row
   of its hunk (top/bottom border, rounded corners, and the hunk-to-hunk
   gap), reproducing the same boxed look without a group wrapper. */
.pid-rows {
  display: flex;
  flex-direction: column;
}

.pid-rowbox {
  border-left: 1px solid var(--color-border);
  border-right: 1px solid var(--color-border);
}

.pid-rowbox--start {
  border-top: 1px solid var(--color-border);
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
}

.pid-rowbox--end {
  border-bottom: 1px solid var(--color-border);
  border-bottom-left-radius: 6px;
  border-bottom-right-radius: 6px;
  margin-bottom: 8px;
}

.pid-hunk-header {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  padding: 3px 8px;
  font-size: 11px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 8px;
}

.pid-hunk-header-text {
  flex: 1;
  min-width: 0;
}

/* Tight-packing override so the global .btn--ai fits the per-hunk
   header row (default 32px min-height is too tall for a sub-row). */
.pid-hunk-ai {
  flex-shrink: 0;
  min-height: 20px;
  padding: 1px 10px;
  font-size: 10.5px;
  font-family: inherit;
}
.pid-hunk-ai--active {
  background: var(--color-ai);
  color: var(--color-ai-text);
}
.pid-ai-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* ── Critique panel ────────────────────────────────── */
.pid-critique {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text);
}

.pid-critique--ok         { background: var(--color-success-soft, rgba(34, 197, 94, 0.08));  border-left: 3px solid var(--color-success, #22c55e); }
.pid-critique--nit        { background: var(--color-bg-secondary);                            border-left: 3px solid var(--color-text-muted); }
.pid-critique--suggestion { background: var(--color-accent-soft, rgba(139, 92, 246, 0.08)); border-left: 3px solid var(--color-accent); }
.pid-critique--risk       { background: var(--color-warning-soft, rgba(234, 179, 8, 0.08));   border-left: 3px solid var(--color-warning, #eab308); }

.pid-critique-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
  padding-top: 1px;
}

.pid-critique-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pid-critique-verdict {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.pid-critique-summary {
  color: var(--color-text);
}

.pid-critique-error {
  color: var(--color-danger);
}

.pid-critique-close {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 0 4px;
}

.pid-critique-close:hover { color: var(--color-text); }

/* Diff rows */
.pid-row {
  display: flex;
  align-items: stretch;
  min-height: 20px;
  line-height: 20px;
  border-bottom: 1px solid transparent;
  position: relative; /* anchor for .pid-ann (v2.18) */
}

/* ─── CI annotation gutter (v2.18) ───────────────────────── */
.pid-ann {
  position: absolute;
  left: 2px;
  top: 0;
  height: 20px;
  display: flex;
  align-items: center;
  z-index: 5;
}
.pid-ann-icon {
  font-size: 11px;
  line-height: 1;
  cursor: default;
}
.pid-ann-icon--warning { color: var(--color-warning); }
.pid-ann-icon--notice  { color: var(--color-info, var(--color-accent)); }
/* The annotated line gets a subtle left accent so it stays visible
   even when the emoji glyph blends with the theme. */
.pid-row--annotated { box-shadow: inset 2px 0 0 var(--color-warning); }
/* The "+" hover affordance of the old-lno cell would overlap the icon —
   commenting stays available via the new-lno cell. */
.pid-row--annotated .pid-lno:first-of-type .pid-lno-icon { display: none; }

.pid-ann-tip {
  display: none;
  position: absolute;
  left: 0;
  top: 20px;
  z-index: 30;
  min-width: 260px;
  max-width: 420px;
  padding: 8px 10px;
  background: var(--color-bg-elevated, var(--color-bg-secondary));
  border: 1px solid var(--color-border-strong, var(--color-border));
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.35));
  font-size: 12px;
  line-height: 1.45;
  white-space: normal;
}
.pid-ann:hover .pid-ann-tip { display: block; }
.pid-ann-tip-item + .pid-ann-tip-item {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}
.pid-ann-tip-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-weight: 600;
  color: var(--color-text);
}
.pid-ann-tip-title {
  overflow-wrap: anywhere;
}
/* E1 — AI finding confidence (C4 renders real values here) */
.pid-ann-tip-confidence {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.pid-ann-tip-msg {
  margin-top: 2px;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 160px;
  overflow-y: auto;
}
.pid-ann-tip-src {
  margin-top: 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.pid-row--add { background: var(--color-success-soft); }
.pid-row--del { background: var(--color-danger-soft); }
.pid-row--ctx { background: transparent; }

/* Line numbers */
.pid-lno {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 40px;
  min-width: 40px;
  padding: 0 6px;
  color: var(--color-text-muted);
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  user-select: none;
  position: relative;
  font-size: 11px;
}

.pid-lno-num { flex: 1; text-align: right; }
.pid-lno-icon {
  position: absolute;
  left: 2px;
  color: var(--color-accent);
  font-size: 12px;
  font-weight: bold;
  opacity: 0;
  transition: opacity 0.1s;
}

.pid-lno--clickable { cursor: pointer; }
.pid-lno--clickable:hover { background: var(--color-accent-soft); }
.pid-lno--clickable:hover .pid-lno-icon { opacity: 1; }

/* Marker column */
.pid-marker {
  width: 18px;
  min-width: 18px;
  text-align: center;
  color: var(--color-text-muted);
  border-right: 1px solid var(--color-border);
}
.pid-row--add .pid-marker { color: var(--color-success); }
.pid-row--del .pid-marker { color: var(--color-danger); }

/* Content column */
.pid-content {
  flex: 1;
  padding: 0 8px;
  white-space: pre;
  overflow: hidden;
  color: var(--color-text);
}

/* Thread row (spans full width) */
.pid-thread-row {
  display: flex;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.pid-thread-gutter {
  width: 98px; /* 40 + 40 + 18 px = gutter width */
  min-width: 98px;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
}

.pid-thread-body {
  flex: 1;
  padding: 8px 12px;
}

/* Compose box */
.pid-compose {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pid-compose-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.pid-textarea {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  font-size: 12px;
  padding: 6px 8px;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
}
.pid-textarea:focus { outline: none; border-color: var(--color-accent); }

.pid-cancel-btn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}
.pid-cancel-btn:hover { border-color: var(--color-text-muted); }

.pid-review-btn {
  background: none;
  border: 1px solid var(--color-accent);
  border-radius: 4px;
  color: var(--color-accent);
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.pid-review-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pid-review-btn:not(:disabled):hover { background: var(--color-accent-soft); }

.pid-submit-btn {
  background: var(--color-accent);
  border: none;
  border-radius: 4px;
  color: var(--color-accent-text);
  padding: 3px 12px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.pid-submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pid-submit-btn:not(:disabled):hover { filter: brightness(1.1); }

/* ── Suggest button (v2.13) ────────────────────────────── */
.pid-suggest-btn {
  flex-shrink: 0;
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  color: var(--color-text-muted);
  cursor: pointer;
  margin: 0 4px;
  transition: background 0.1s, color 0.1s;
}

.pid-row:hover .pid-suggest-btn {
  display: flex;
}

.pid-suggest-btn:hover {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

/* ── Suggestion editor row ──────────────────────────────── */
.pid-suggest-row {
  background: var(--color-bg-secondary);
}

.pid-suggest {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pid-suggest-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text);
}

.pid-suggest-hint {
  font-weight: 400;
  color: var(--color-text-muted);
  font-size: 10px;
  margin-left: 2px;
}

.pid-suggest-preview {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--color-bg);
}

.pid-suggest-fence {
  font-family: monospace;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  padding: 2px 8px;
  border-bottom: 1px solid var(--color-border);
  display: block;
}

.pid-suggest-fence:last-child {
  border-top: 1px solid var(--color-border);
  border-bottom: none;
}

.pid-suggest-textarea {
  border: none;
  border-radius: 0;
  background: var(--color-success-soft);
}

.pid-suggest-textarea:focus {
  outline: none;
  border-color: transparent;
}
</style>
