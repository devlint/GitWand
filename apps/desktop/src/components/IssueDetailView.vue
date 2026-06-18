<script setup lang="ts">
/**
 * IssueDetailView — in-app GitHub issue detail (v2.22).
 *
 * The issue equivalent of PrDetailView: read the body + conversation, add a
 * comment, and close/reopen — all without leaving GitWand. State lives in the
 * provided `useIssuePanel` singleton (App.vue), so the Launchpad can drive
 * navigation into it.
 */
import { inject } from "vue";
import { ISSUE_PANEL_KEY, type IssuePanelState } from "../composables/useIssuePanel";
import { useI18n } from "../composables/useI18n";
import { avatarStyle, avatarInitials } from "../composables/useAvatar";
import { openExternalUrl } from "../utils/backend-pr";

const { t } = useI18n();
const panel = inject<IssuePanelState>(ISSUE_PANEL_KEY);

function openOnWeb(url: string) {
  if (url) void openExternalUrl(url);
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}
</script>

<template>
  <div class="issue-view" v-if="panel">
    <!-- Loading (cold) -->
    <div v-if="panel.loading.value && !panel.detail.value" class="issue-view__center">
      <span class="issue-view__spinner" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 42"></circle>
        </svg>
      </span>
      <span>{{ t("issue.loadingLabel") }}</span>
    </div>

    <!-- Empty (nothing selected) -->
    <div v-else-if="!panel.detail.value && !panel.error.value" class="issue-view__center issue-view__center--muted">
      {{ t("issue.empty") }}
    </div>

    <!-- Content -->
    <div v-else-if="panel.detail.value" class="issue-view__frame">
      <!-- Header -->
      <div class="issue-view__header">
        <span
          class="issue-view__state"
          :class="panel.isOpen.value ? 'issue-view__state--open' : 'issue-view__state--closed'"
        >
          {{ panel.isOpen.value ? t("issue.openBadge") : t("issue.closedBadge") }}
        </span>
        <h2 class="issue-view__title">
          {{ panel.detail.value.title }}
          <span class="issue-view__num">#{{ panel.detail.value.number }}</span>
        </h2>
        <div class="issue-view__header-actions">
          <button
            class="issue-view__btn"
            :disabled="panel.mutating.value"
            @click="panel.toggleState()"
          >
            {{ panel.isOpen.value ? t("issue.close") : t("issue.reopen") }}
          </button>
          <button class="issue-view__btn issue-view__btn--ghost" @click="openOnWeb(panel.detail.value.url)">
            {{ t("issue.openOnWeb") }}
          </button>
        </div>
      </div>

      <!-- Meta -->
      <div class="issue-view__meta">
        <span class="issue-view__author">
          <span class="issue-view__avatar" :style="avatarStyle(panel.detail.value.author)" aria-hidden="true">
            {{ avatarInitials(panel.detail.value.author) }}
          </span>
          {{ panel.detail.value.author }}
        </span>
        <span class="issue-view__date">{{ fmtDate(panel.detail.value.createdAt) }}</span>
        <span v-if="panel.detail.value.milestone" class="issue-view__chip">
          {{ t("issue.milestone") }}: {{ panel.detail.value.milestone }}
        </span>
        <span
          v-for="label in panel.detail.value.labels"
          :key="label"
          class="issue-view__chip issue-view__chip--label"
        >{{ label }}</span>
        <span
          v-for="login in panel.detail.value.assignees"
          :key="`a-${login}`"
          class="issue-view__chip"
        >@{{ login }}</span>
      </div>

      <div v-if="panel.error.value" class="issue-view__error">{{ panel.error.value }}</div>

      <!-- Body -->
      <div class="issue-view__body">
        <p v-if="!panel.detail.value.body" class="issue-view__muted">{{ t("issue.noBody") }}</p>
        <pre v-else class="issue-view__markdown">{{ panel.detail.value.body }}</pre>
      </div>

      <!-- Comments -->
      <div class="issue-view__comments">
        <h3 class="issue-view__section-title">
          {{ t("issue.commentsTitle") }}
          <span class="issue-view__count">{{ panel.comments.value.length }}</span>
        </h3>
        <p v-if="panel.comments.value.length === 0" class="issue-view__muted">{{ t("issue.noComments") }}</p>
        <ul v-else class="issue-view__comment-list">
          <li v-for="c in panel.comments.value" :key="c.id" class="issue-view__comment">
            <div class="issue-view__comment-head">
              <span class="issue-view__avatar issue-view__avatar--sm" :style="avatarStyle(c.author)" aria-hidden="true">
                {{ avatarInitials(c.author) }}
              </span>
              <span class="issue-view__comment-author">{{ c.author }}</span>
              <span class="issue-view__date">{{ fmtDate(c.created_at) }}</span>
            </div>
            <pre class="issue-view__markdown">{{ c.body }}</pre>
          </li>
        </ul>

        <!-- Add comment -->
        <div class="issue-view__add">
          <textarea
            v-model="panel.newComment.value"
            class="issue-view__textarea"
            :placeholder="t('issue.commentPlaceholder')"
            rows="3"
          ></textarea>
          <button
            class="issue-view__btn issue-view__btn--primary"
            :disabled="panel.posting.value || !panel.newComment.value.trim()"
            @click="panel.addComment()"
          >
            {{ panel.posting.value ? t("issue.posting") : t("issue.addComment") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Error (no detail) -->
    <div v-else class="issue-view__center issue-view__center--muted">
      {{ panel.error.value }}
    </div>
  </div>
</template>

<style scoped>
.issue-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  color: var(--color-text);
  overflow-y: auto;
}

.issue-view__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--color-text);
}
.issue-view__center--muted { color: var(--color-text-muted); }

.issue-view__spinner svg { animation: issue-spin 0.9s linear infinite; }
@keyframes issue-spin { to { transform: rotate(360deg); } }

.issue-view__frame {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6) var(--space-7);
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.issue-view__header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.issue-view__title {
  flex: 1;
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.issue-view__num { color: var(--color-text-muted); font-weight: var(--font-weight-regular); }

.issue-view__state {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  margin-top: 3px;
}
.issue-view__state--open { background: var(--color-success-soft); color: var(--color-success); }
.issue-view__state--closed { background: var(--color-danger-soft); color: var(--color-danger); }

.issue-view__header-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

.issue-view__btn {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.issue-view__btn:hover:not(:disabled) { background: var(--color-bg-tertiary); border-color: var(--color-border-strong); }
.issue-view__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.issue-view__btn--ghost { background: transparent; }
.issue-view__btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.issue-view__btn--primary:hover:not(:disabled) { background: var(--color-accent-hover); }

.issue-view__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.issue-view__author { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--color-text); font-weight: var(--font-weight-medium); }

.issue-view__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
}
.issue-view__avatar--sm { width: 20px; height: 20px; }

.issue-view__chip {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}
.issue-view__chip--label { color: var(--color-accent); }

.issue-view__error {
  padding: var(--space-3) var(--space-4);
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}

.issue-view__body {
  padding: var(--space-4) var(--space-5);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.issue-view__markdown {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-sans, inherit);
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--color-text);
}

.issue-view__muted { color: var(--color-text-muted); font-style: italic; margin: 0; }

.issue-view__section-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  margin: 0 0 var(--space-4);
}
.issue-view__count {
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.issue-view__comment-list { list-style: none; margin: 0 0 var(--space-5); padding: 0; display: flex; flex-direction: column; gap: var(--space-4); }
.issue-view__comment {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  /* White in light theme (#fff), elevated surface in dark — so the comment
     body reads as a card, not the off-white page background behind it. */
  background: var(--color-bg-secondary);
}
.issue-view__comment-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
}
.issue-view__comment-author { font-weight: var(--font-weight-medium); color: var(--color-text); }
.issue-view__comment .issue-view__markdown { padding: var(--space-4); }

.issue-view__add { display: flex; flex-direction: column; gap: var(--space-3); }
.issue-view__textarea {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  font-family: inherit;
  font-size: var(--font-size-md);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  resize: vertical;
}
.issue-view__textarea:focus { outline: none; border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.issue-view__add .issue-view__btn--primary { align-self: flex-end; }

.issue-view__date { color: var(--color-text-subtle); font-size: var(--font-size-xs); }
</style>
