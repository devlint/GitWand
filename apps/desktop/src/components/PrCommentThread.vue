<script setup lang="ts">
/**
 * PrCommentThread.vue
 *
 * Renders a thread of PR review comments (root + replies) with:
 *  - Reply compose box
 *  - Edit / delete on own comments
 *  - Code suggestion detection & "Apply" button
 */
import { ref, computed } from "vue";
import type { PrReviewComment } from "../utils/backend";

const props = defineProps<{
  /** All comments in this thread, sorted oldest first. */
  comments: PrReviewComment[];
  /** GitHub login of the authenticated user (to show edit/delete on own comments). */
  currentUser?: string;
  /** Whether to show the compose box for a new reply immediately. */
  autoFocus?: boolean;
}>();

const emit = defineEmits<{
  (e: "reply", body: string): void;
  (e: "delete", id: number): void;
  (e: "edit", id: number, body: string): void;
  (e: "apply-suggestion", suggestion: string, startLine: number | null, endLine: number | null): void;
}>();

// ─── Compose ────────────────────────────────────────────
const replyText = ref("");
const showReply = ref(props.autoFocus ?? false);

function submitReply() {
  const body = replyText.value.trim();
  if (!body) return;
  emit("reply", body);
  replyText.value = "";
  showReply.value = false;
}

// ─── Edit ────────────────────────────────────────────────
const editingId = ref<number | null>(null);
const editText = ref("");

function startEdit(comment: PrReviewComment) {
  editingId.value = comment.id;
  editText.value = comment.body;
}

function submitEdit() {
  if (editingId.value == null) return;
  const body = editText.value.trim();
  if (!body) return;
  emit("edit", editingId.value, body);
  editingId.value = null;
}

function cancelEdit() {
  editingId.value = null;
  editText.value = "";
}

// ─── Code suggestion ────────────────────────────────────
/** Parse a ```suggestion block from a comment body. Returns the code or null. */
function parseSuggestion(body: string): string | null {
  const m = body.match(/^```suggestion\r?\n([\s\S]*?)```\s*$/m);
  return m ? m[1] : null;
}

function hasSuggestion(comment: PrReviewComment) {
  return parseSuggestion(comment.body) !== null;
}

function applySuggestion(comment: PrReviewComment) {
  const code = parseSuggestion(comment.body);
  if (!code) return;
  emit("apply-suggestion", code, comment.start_line, comment.line);
}

// ─── Markdown-lite renderer ─────────────────────────────
/** Very light renderer: code blocks, inline code, bold, links. */
function renderBody(body: string): string {
  // Replace suggestion blocks with a styled box
  let html = body.replace(
    /```suggestion\r?\n([\s\S]*?)```/gm,
    (_, code) =>
      `<div class="comment-suggestion"><div class="comment-suggestion-label">💡 Suggestion</div><pre class="comment-suggestion-code">${escHtml(code)}</pre></div>`,
  );
  // Other fenced code blocks
  html = html.replace(
    /```(\w*)\r?\n([\s\S]*?)```/gm,
    (_, lang, code) => `<pre class="comment-code-block" data-lang="${lang}">${escHtml(code)}</pre>`,
  );
  // Inline code
  html = html.replace(/`([^`]+)`/g, (_, c) => `<code class="comment-inline-code">${escHtml(c)}</code>`);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Links
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  // Newlines → <br>
  html = html.replace(/\n/g, "<br>");
  return html;
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function timeAgo(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}j`;
  } catch { return dateStr; }
}
</script>

<template>
  <div class="pct-thread">
    <!-- Comments -->
    <div
      v-for="comment in comments"
      :key="comment.id"
      class="pct-comment"
    >
      <!-- Header -->
      <div class="pct-comment-header">
        <div class="pct-avatar">{{ comment.author.slice(0, 1).toUpperCase() }}</div>
        <span class="pct-author">{{ comment.author }}</span>
        <span class="pct-time" :title="comment.created_at">{{ timeAgo(comment.created_at) }}</span>
        <div class="pct-actions" v-if="comment.author === currentUser || !currentUser">
          <button
            v-if="editingId !== comment.id"
            class="pct-action-btn"
            @click="startEdit(comment)"
            title="Modifier"
          >✏️</button>
          <button
            class="pct-action-btn pct-action-btn--del"
            @click="emit('delete', comment.id)"
            title="Supprimer"
          >🗑</button>
        </div>
      </div>

      <!-- Body (edit mode or read mode) -->
      <div v-if="editingId === comment.id" class="pct-edit-box">
        <textarea
          v-model="editText"
          class="pct-textarea"
          rows="4"
          @keydown.ctrl.enter.prevent="submitEdit"
          @keydown.meta.enter.prevent="submitEdit"
          @keydown.escape="cancelEdit"
        />
        <div class="pct-edit-actions">
          <button class="pct-cancel-btn" @click="cancelEdit">Annuler</button>
          <button class="pct-submit-btn" @click="submitEdit" :disabled="!editText.trim()">Enregistrer</button>
        </div>
      </div>
      <div v-else class="pct-body" v-html="renderBody(comment.body)" />

      <!-- Apply suggestion button -->
      <div v-if="hasSuggestion(comment) && editingId !== comment.id" class="pct-suggestion-actions">
        <button class="pct-apply-btn" @click="applySuggestion(comment)">
          ✅ Appliquer la suggestion
        </button>
      </div>
    </div>

    <!-- Reply area -->
    <div class="pct-reply-area">
      <div v-if="showReply" class="pct-compose">
        <textarea
          v-model="replyText"
          class="pct-textarea"
          placeholder="Répondre… (Ctrl+Enter pour envoyer)"
          rows="3"
          autofocus
          @keydown.ctrl.enter.prevent="submitReply"
          @keydown.meta.enter.prevent="submitReply"
          @keydown.escape="showReply = false"
        />
        <div class="pct-compose-actions">
          <button class="pct-cancel-btn" @click="showReply = false; replyText = ''">Annuler</button>
          <button class="pct-submit-btn" @click="submitReply" :disabled="!replyText.trim()">Répondre</button>
        </div>
      </div>
      <button v-else class="pct-reply-trigger" @click="showReply = true">
        💬 Répondre
      </button>
    </div>
  </div>
</template>

<style scoped>
.pct-thread {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
  font-size: 12px;
}

.pct-comment {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
}
.pct-comment:last-child { border-bottom: none; }

.pct-comment-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.pct-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.pct-author {
  font-weight: 600;
  color: var(--color-text);
  font-size: 11px;
}

.pct-time {
  color: var(--color-text-muted);
  font-size: 10px;
  margin-left: auto;
}

.pct-actions {
  display: flex;
  gap: 2px;
  margin-left: 4px;
}

.pct-action-btn {
  background: none;
  border: none;
  padding: 1px 3px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  opacity: 0.5;
  transition: opacity 0.1s;
}
.pct-action-btn:hover { opacity: 1; background: var(--color-bg-tertiary); }
.pct-action-btn--del:hover { background: var(--color-danger-soft); }

.pct-body {
  color: var(--color-text);
  line-height: 1.5;
  word-break: break-word;
}

/* Markdown rendered content */
:deep(.comment-code-block),
:deep(.comment-suggestion-code) {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 4px 0;
  font-family: monospace;
  font-size: 11px;
  overflow-x: auto;
  white-space: pre;
}

:deep(.comment-inline-code) {
  background: var(--color-bg-tertiary);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 11px;
}

:deep(.comment-suggestion) {
  border: 1px solid var(--color-accent);
  border-radius: 6px;
  overflow: hidden;
  margin: 4px 0;
}

:deep(.comment-suggestion-label) {
  background: var(--color-accent-soft);
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--color-accent);
}

:deep(.comment-suggestion-code) {
  border: none;
  border-radius: 0;
  margin: 0;
}

:deep(a) { color: var(--color-accent); text-decoration: underline; }

/* Suggestion apply button */
.pct-suggestion-actions {
  margin-top: 6px;
}

.pct-apply-btn {
  background: var(--color-success-soft);
  border: 1px solid var(--color-success);
  border-radius: 4px;
  color: var(--color-success);
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}
.pct-apply-btn:hover { background: var(--color-success); color: var(--color-success-text); }

/* Edit box */
.pct-edit-box { display: flex; flex-direction: column; gap: 6px; }
.pct-edit-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* Reply area */
.pct-reply-area {
  padding: 6px 12px;
  background: var(--color-bg-secondary);
}

.pct-reply-trigger {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 0;
  transition: color 0.1s;
}
.pct-reply-trigger:hover { color: var(--color-accent); }

.pct-compose { display: flex; flex-direction: column; gap: 6px; }
.pct-compose-actions { display: flex; gap: 6px; justify-content: flex-end; }

.pct-textarea {
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
.pct-textarea:focus { outline: none; border-color: var(--color-accent); }

.pct-cancel-btn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}
.pct-cancel-btn:hover { border-color: var(--color-text-muted); }

.pct-submit-btn {
  background: var(--color-accent);
  border: none;
  border-radius: 4px;
  color: var(--color-accent-text);
  padding: 3px 12px;
  font-size: 11px;
  cursor: pointer;
  font-weight: 600;
}
.pct-submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pct-submit-btn:not(:disabled):hover { filter: brightness(1.1); }
</style>
