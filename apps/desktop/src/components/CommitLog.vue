<script setup lang="ts">
import { computed } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
const { t } = useI18n();

const props = defineProps<{
  entries: GitLogEntry[];
  loading: boolean;
  selectedHash: string | null;
  aheadCount?: number;
  /**
   * True when the current branch has no upstream configured yet.
   * In that case every local commit is effectively "unpushed" because
   * origin does not know about this branch at all.
   */
  needsPublish?: boolean;
}>();

/**
 * Effective count of unpushed commits used for styling:
 * - when the branch has no upstream, every local commit is unpushed
 * - otherwise, use aheadCount reported by git status
 */
const effectiveAhead = computed(() =>
  props.needsPublish ? props.entries.length : (props.aheadCount ?? 0),
);

const emit = defineEmits<{
  selectCommit: [hash: string];
  editCommit: [entry: GitLogEntry];
}>();

function relativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return t('date.now');
  if (diffMin < 60) return t('date.minutesAgo', diffMin);
  if (diffHour < 24) return t('date.hoursAgo', diffHour);
  if (diffDay < 7) return t('date.daysAgo', diffDay);
  if (diffDay < 30) return t('date.weeksAgo', Math.floor(diffDay / 7));
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function authorInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function authorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}
</script>

<template>
  <div class="commit-log">
    <div class="log-loading" v-if="loading">
      <div class="loading-spinner"></div>
      <span class="muted">{{ t('common.loading') }}</span>
    </div>

    <ul class="log-list" v-else-if="entries.length > 0">
      <template v-for="(entry, idx) in entries" :key="entry.hashFull">
        <!-- Section label before first unpushed commit (or unpublished branch) -->
        <li
          v-if="effectiveAhead > 0 && idx === 0"
          class="log-section-label"
          :class="needsPublish ? 'log-section-label--unpublished' : 'log-section-label--unpushed'"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span v-if="needsPublish">{{ t('log.unpublishedBranch') }}</span>
          <span v-else>{{ effectiveAhead }} {{ effectiveAhead === 1 ? t('log.unpushedOne') : t('log.unpushedMany') }}</span>
        </li>
        <!-- Section label before first pushed commit -->
        <li v-if="!needsPublish && effectiveAhead > 0 && idx === effectiveAhead" class="log-section-label log-section-label--pushed">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13.5 3.5l-7 7L3 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('log.pushed') }}</span>
        </li>
        <!-- Commit item -->
        <li
          class="commit-item"
          :class="{
            'commit-item--selected': selectedHash === entry.hashFull,
            'commit-item--unpushed': idx < effectiveAhead,
          }"
          @click="emit('selectCommit', entry.hashFull)"
          tabindex="0"
          @keydown.enter="emit('selectCommit', entry.hashFull)"
        >
          <div class="commit-avatar" :style="{ background: authorColor(entry.author) }">
            {{ authorInitials(entry.author) }}
          </div>
          <div class="commit-info">
            <div class="commit-message">
              {{ entry.message }}
              <span v-if="idx < effectiveAhead" class="unpushed-badge">{{ needsPublish ? t('log.unpublishedBadge') : 'unpushed' }}</span>
            </div>
            <div class="commit-meta">
              <span class="commit-hash mono">{{ entry.hash }}</span>
              <span class="commit-separator" aria-hidden="true">&middot;</span>
              <span class="commit-author">{{ entry.author }}</span>
              <span class="commit-separator" aria-hidden="true">&middot;</span>
              <time class="commit-date" :datetime="entry.date">{{ relativeDate(entry.date) }}</time>
            </div>
          </div>
          <!-- Edit button — HEAD unpushed only -->
          <button
            v-if="aheadCount != null && idx === 0"
            class="commit-edit-btn"
            @click.stop="emit('editCommit', entry)"
            :title="t('log.editMessage')"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
            </svg>
          </button>
        </li>
      </template>
    </ul>

    <div class="log-empty" v-else>
      <span class="muted">{{ t('log.noCommit') }}</span>
    </div>
  </div>
</template>

<style scoped>
.commit-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.log-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.log-list {
  list-style: none;
  flex: 1;
  overflow-y: auto;
}

/* ─── Section labels ──────────────────────────────────── */

.log-section-label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-4);
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 1;
}

.log-section-label--unpushed {
  color: var(--color-warning);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-warning);
}

.log-section-label--unpublished {
  color: var(--color-accent);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-accent);
}

.log-section-label--pushed {
  color: var(--color-success);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-success);
}

/* ─── Commit item ─────────────────────────────────────── */

.commit-item {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background var(--transition-fast);
  border-left: 3px solid transparent;
}

.commit-item--unpushed {
  border-left-color: var(--color-warning);
  background: var(--color-warning-soft);
}

.commit-item--unpushed:hover {
  background: var(--color-warning-soft);
  opacity: 0.9;
}

.unpushed-badge {
  display: inline-block;
  font-size: 9px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  margin-left: var(--space-1);
  vertical-align: middle;
}

.commit-item:hover {
  background: var(--color-bg-tertiary);
}

.commit-item--selected {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent);
}

.commit-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.commit-item:last-child {
  border-bottom: none;
}

.commit-edit-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: none;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
  align-self: center;
}

.commit-item:hover .commit-edit-btn {
  opacity: 0.7;
}

.commit-edit-btn:hover {
  opacity: 1 !important;
  color: var(--color-accent);
  background: var(--color-bg);
}

.commit-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  color: var(--color-accent-text);
  flex-shrink: 0;
  margin-top: 2px;
}

.commit-info {
  flex: 1;
  min-width: 0;
}

.commit-message {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: 3px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.commit-hash {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
}

.commit-separator {
  opacity: 0.4;
}

.commit-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-date {
  flex-shrink: 0;
}

.log-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-10);
}
</style>
