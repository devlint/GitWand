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
import PrCommentThread from "./PrCommentThread.vue";
import { detectLanguage, highlightLine } from "../utils/highlight";

const props = defineProps<{
  diff: GitDiff | null;
  filePath: string | null;
  /** All review comments for this file. */
  comments: PrReviewComment[];
  /** GitHub login of the authenticated user. */
  currentUser?: string;
  /** Number of comments already staged in the pending review draft. */
  reviewDraftCount?: number;
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

// ─── Compose new comment ─────────────────────────────────
interface ComposeLine {
  hunkIdx: number;
  lineIdx: number;
  line: number;
  side: "LEFT" | "RIGHT";
}

const composeLine = ref<ComposeLine | null>(null);
const composeText = ref("");

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
</script>

<template>
  <div class="pid-root">
    <div v-if="!diff || !diff.hunks.length" class="pid-empty">
      Aucun diff disponible.
    </div>
    <template v-else>
      <div
        v-for="(hunk, hunkIdx) in diff.hunks"
        :key="hunkIdx"
        class="pid-hunk"
      >
        <!-- Hunk header -->
        <div class="pid-hunk-header mono">{{ hunk.header }}</div>

        <!-- Lines -->
        <template v-for="(dl, lineIdx) in hunk.lines" :key="lineIdx">
          <!-- Diff row -->
          <div
            class="pid-row"
            :class="{
              'pid-row--add': dl.type === 'add',
              'pid-row--del': dl.type === 'delete',
              'pid-row--ctx': dl.type === 'context',
            }"
          >
            <!-- Old line number -->
            <div
              class="pid-lno mono"
              :class="{ 'pid-lno--clickable': dl.type !== 'add' }"
              @click="dl.type !== 'add' && openCompose(hunkIdx, lineIdx, dl)"
              :title="dl.type !== 'add' ? 'Ajouter un commentaire' : undefined"
            >
              <span class="pid-lno-num">{{ dl.oldLineNo ?? '' }}</span>
              <span class="pid-lno-icon">+</span>
            </div>
            <!-- New line number -->
            <div
              class="pid-lno mono"
              :class="{ 'pid-lno--clickable': dl.type !== 'delete' }"
              @click="dl.type !== 'delete' && openCompose(hunkIdx, lineIdx, dl)"
              :title="dl.type !== 'delete' ? 'Ajouter un commentaire' : undefined"
            >
              <span class="pid-lno-num">{{ dl.newLineNo ?? '' }}</span>
              <span class="pid-lno-icon">+</span>
            </div>
            <!-- Marker -->
            <div class="pid-marker mono">
              {{ dl.type === 'add' ? '+' : dl.type === 'delete' ? '-' : ' ' }}
            </div>
            <!-- Content -->
            <div class="pid-content mono" v-html="hl(dl.content) || '&nbsp;'" />
          </div>

          <!-- Comment threads anchored to this line -->
          <div
            v-for="thread in threadsForLine(dl)"
            :key="thread.key"
            class="pid-thread-row"
          >
            <div class="pid-thread-gutter" />
            <div class="pid-thread-body">
              <PrCommentThread
                :comments="thread.comments"
                :current-user="currentUser"
                @reply="(body) => handleReply(thread, body)"
                @edit="handleEdit"
                @delete="handleDelete"
                @apply-suggestion="handleApplySuggestion"
              />
            </div>
          </div>

          <!-- Compose box anchored to this line -->
          <div
            v-if="isComposeAnchoredAt(dl)"
            class="pid-thread-row pid-compose-row"
          >
            <div class="pid-thread-gutter" />
            <div class="pid-thread-body">
              <div class="pid-compose">
                <textarea
                  v-model="composeText"
                  class="pid-textarea"
                  placeholder="Ajouter un commentaire… (Ctrl+Enter pour envoyer)"
                  rows="3"
                  autofocus
                  @keydown.ctrl.enter.prevent="submitCompose"
                  @keydown.meta.enter.prevent="submitCompose"
                  @keydown.escape="closeCompose"
                />
                <div class="pid-compose-actions">
                  <button class="pid-cancel-btn" @click="closeCompose">Annuler</button>
                  <button
                    class="pid-review-btn"
                    :disabled="!composeText.trim()"
                    @click="submitToReview"
                    :title="reviewDraftCount ? `Ajouter à la review (${reviewDraftCount} en attente)` : 'Ajouter à la review'"
                  >
                    {{ reviewDraftCount ? `+ Review (${reviewDraftCount})` : '+ Review' }}
                  </button>
                  <button
                    class="pid-submit-btn"
                    :disabled="!composeText.trim()"
                    @click="submitCompose"
                  >Commenter</button>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>
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

.pid-hunk {
  margin-bottom: 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}

.pid-hunk-header {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  padding: 3px 8px;
  font-size: 11px;
  border-bottom: 1px solid var(--color-border);
}

/* Diff rows */
.pid-row {
  display: flex;
  align-items: stretch;
  min-height: 20px;
  line-height: 20px;
  border-bottom: 1px solid transparent;
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
</style>
