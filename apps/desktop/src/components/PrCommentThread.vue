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
import { renderMarkdown, onMarkdownLinkClick } from "../composables/useSafeHtml";
import { useI18n } from "../composables/useI18n";
import Avatar from "./Avatar.vue";
import PrReactions from "./PrReactions.vue";

const { t } = useI18n();

const props = defineProps<{
  /** All comments in this thread, sorted oldest first. */
  comments: PrReviewComment[];
  /** GitHub login of the authenticated user (to show edit/delete on own comments). */
  currentUser?: string;
  /** Whether to show the compose box for a new reply immediately. */
  autoFocus?: boolean;
  /** Repo working directory — required for reactions. */
  cwd?: string;
  /** PR number — required for reactions. */
  prNumber?: number;
  /** Forge name — routes reactions to the right backend. */
  forgeName?: string;
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

const suggLabel = computed(() => t("pr.comment.suggestionLabel"));

// Render each comment's markdown once per data change. Done here rather than in
// the `v-html` binding so the (expensive) parse + sanitize doesn't re-run on
// every component re-render for every comment in the thread.
const bodyHtmlById = computed(() => {
  const m = new Map<number, string>();
  for (const c of props.comments) m.set(c.id, renderMarkdown(c.body));
  return m;
});


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
        <Avatar class="pct-avatar" :name="comment.author" />
        <span class="pct-author">{{ comment.author }}</span>
        <span class="pct-time" :title="comment.created_at">{{ timeAgo(comment.created_at) }}</span>
        <div class="pct-actions" v-if="comment.author === currentUser || !currentUser">
          <button
            v-if="editingId !== comment.id"
            class="pct-action-btn"
            @click="startEdit(comment)"
            :title="t('pr.comment.edit')"
          >✏️</button>
          <button
            class="pct-action-btn pct-action-btn--del"
            @click="emit('delete', comment.id)"
            :title="t('pr.comment.delete')"
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
          <button class="pct-cancel-btn" @click="cancelEdit">{{ t('pr.comment.cancel') }}</button>
          <button class="pct-submit-btn" @click="submitEdit" :disabled="!editText.trim()">{{ t('pr.comment.save') }}</button>
        </div>
      </div>
      <div
        v-else
        class="pct-body"
        :style="{ '--suggestion-label': `'${suggLabel}'` }"
        @click="onMarkdownLinkClick"
        v-html="bodyHtmlById.get(comment.id)"
      />
      <PrReactions
        v-if="cwd && prNumber"
        :cwd="cwd"
        :pr-number="prNumber"
        target-type="review_comment"
        :target-id="comment.id"
        :current-user="currentUser"
        :forge-name="forgeName"
      />

      <!-- Apply suggestion button -->
      <div v-if="hasSuggestion(comment) && editingId !== comment.id" class="pct-suggestion-actions">
        <button class="pct-apply-btn" @click="applySuggestion(comment)">
          {{ t('pr.comment.applySuggestion') }}
        </button>
      </div>
    </div>

    <!-- Reply area -->
    <div class="pct-reply-area">
      <div v-if="showReply" class="pct-compose">
        <textarea
          v-model="replyText"
          class="pct-textarea"
          :placeholder="t('pr.comment.replyPlaceholder')"
          rows="3"
          autofocus
          @keydown.ctrl.enter.prevent="submitReply"
          @keydown.meta.enter.prevent="submitReply"
          @keydown.escape="showReply = false"
        />
        <div class="pct-compose-actions">
          <button class="pct-cancel-btn" @click="showReply = false; replyText = ''">{{ t('pr.comment.cancel') }}</button>
          <button class="pct-submit-btn" @click="submitReply" :disabled="!replyText.trim()">{{ t('pr.comment.replyShort') }}</button>
        </div>
      </div>
      <button v-else class="pct-reply-trigger" @click="showReply = true">
        {{ t('pr.comment.replyBtn') }}
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
  border: 1.5px solid currentColor;
  font-size: 9px;
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
.pct-body :deep(p) { margin-bottom: 12px; }
.pct-body :deep(p:last-child) { margin-bottom: 0; }

.pct-body :deep(h1),
.pct-body :deep(h2),
.pct-body :deep(h3),
.pct-body :deep(h4),
.pct-body :deep(h5),
.pct-body :deep(h6) {
  margin-top: 16px;
  margin-bottom: 8px;
  font-weight: 600;
  line-height: 1.3;
}
.pct-body :deep(h1:first-child),
.pct-body :deep(h2:first-child),
.pct-body :deep(h3:first-child),
.pct-body :deep(h4:first-child) {
  margin-top: 0;
}

.pct-body :deep(h1) { font-size: 1.4em; }
.pct-body :deep(h2) { font-size: 1.25em; }
.pct-body :deep(h3) { font-size: 1.15em; }
.pct-body :deep(h4) { font-size: 1.1em; }

.pct-body :deep(ul),
.pct-body :deep(ol) {
  margin-bottom: 8px;
  padding-left: 20px;
}
.pct-body :deep(li) { margin-bottom: 2px; }

.pct-body :deep(.md-code-block) {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 8px 0;
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-x: auto;
  white-space: pre;
}

.pct-body :deep(.md-inline-code) {
  background: var(--color-bg-tertiary);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.pct-body :deep(.md-suggestion-block) {
  border: 1px solid var(--color-accent);
  border-radius: 6px;
  overflow: hidden;
  margin: 8px 0;
  background: var(--color-bg-secondary);
}

.pct-body :deep(.md-suggestion-block):before {
  content: var(--suggestion-label);
  display: block;
  background: var(--color-accent-soft);
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--color-accent);
  border-bottom: 1px solid var(--color-border);
}

.pct-body :deep(.md-suggestion-block) .md-code-block {
  border: none;
  border-radius: 0;
  margin: 0;
  background: transparent;
}

.pct-body :deep(.md-link) {
  color: var(--color-accent);
  text-decoration: underline;
}

.pct-body :deep(.md-hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 12px 0;
}

.pct-body :deep(.md-table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 12px;
  font-size: var(--font-size-sm);
}
.pct-body :deep(.md-table th),
.pct-body :deep(.md-table td) {
  border: 1px solid var(--color-border);
  padding: 6px 10px;
  text-align: left;
}
.pct-body :deep(.md-table thead th) {
  background: var(--color-bg-secondary);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
}
.pct-body :deep(.md-table tbody tr:nth-child(even)) {
  background: var(--color-bg-secondary);
}

.pct-body :deep(img),
.pct-body :deep(.md-img) {
  max-width: 100%;
  height: auto !important;
  border-radius: var(--radius-sm);
}

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
