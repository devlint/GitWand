<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { GitLogEntry } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { useAIProvider } from "../composables/useAIProvider";
import { useCommitSearch, filterCommitsLocal, type CommitMatch } from "../composables/useCommitSearch";
const { t, locale } = useI18n();

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

// ─── Search (Phase 1.3.4) ─────────────────────────────────
const ai = useAIProvider();
const { isSearching: isAiSearching, searchAI, lastError: aiSearchError } = useCommitSearch();
const searchQuery = ref("");
const aiMatches = ref<CommitMatch[] | null>(null);

const displayedEntries = computed<GitLogEntry[]>(() => {
  if (aiMatches.value !== null) return aiMatches.value.map((m) => m.entry);
  return filterCommitsLocal(props.entries, searchQuery.value);
});

const isSearchActive = computed(
  () => aiMatches.value !== null || searchQuery.value.trim().length > 0,
);

/** Hashes of the commits considered "unpushed" in the original list. */
const unpushedHashes = computed<Set<string>>(() => {
  const set = new Set<string>();
  const ahead = props.needsPublish ? props.entries.length : (props.aheadCount ?? 0);
  for (let i = 0; i < ahead; i++) {
    const e = props.entries[i];
    if (e) set.add(e.hashFull);
  }
  return set;
});

function isUnpushed(entry: GitLogEntry): boolean {
  return unpushedHashes.value.has(entry.hashFull);
}

const reasonByHash = computed(() => {
  const map = new Map<string, string>();
  if (aiMatches.value) {
    for (const m of aiMatches.value) {
      if (m.reason) map.set(m.entry.hashFull, m.reason);
    }
  }
  return map;
});

async function runAiSearch() {
  if (!searchQuery.value.trim()) return;
  try {
    const matches = await searchAI(searchQuery.value, props.entries, {
      locale: locale.value,
    });
    aiMatches.value = matches;
  } catch {
    // surfaced via aiSearchError
  }
}

function clearSearch() {
  searchQuery.value = "";
  aiMatches.value = null;
}

// Clear AI match set when the query changes (typing invalidates the
// prior AI result — the user is refining).
watch(searchQuery, () => {
  aiMatches.value = null;
});

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
    <!-- Search bar -->
    <div v-if="entries.length > 0" class="log-search">
      <svg class="log-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.4"/>
        <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <input
        v-model="searchQuery"
        type="text"
        class="log-search-input"
        :placeholder="t('log.searchPlaceholder')"
        @keydown.enter.prevent="runAiSearch"
        @keydown.esc.prevent="clearSearch"
      />
      <button
        v-if="ai.isAvailable.value && searchQuery.trim()"
        type="button"
        class="log-search-ai"
        :disabled="isAiSearching"
        :title="t('log.searchAiHint')"
        @click="runAiSearch"
      >
        <span v-if="isAiSearching">…</span>
        <span v-else>✨</span>
      </button>
      <button
        v-if="searchQuery || aiMatches !== null"
        type="button"
        class="log-search-clear"
        :title="t('common.close')"
        @click="clearSearch"
      >✕</button>
    </div>
    <p v-if="aiSearchError" class="log-search-error">{{ aiSearchError }}</p>
    <p v-if="aiMatches !== null" class="log-search-status">
      ✨ {{ locale === 'fr'
        ? `Recherche IA : ${displayedEntries.length} commit(s) correspondent.`
        : `AI search: ${displayedEntries.length} matching commit(s).` }}
    </p>

    <div class="log-loading" v-if="loading">
      <div class="loading-spinner"></div>
      <span class="muted">{{ t('common.loading') }}</span>
    </div>

    <ul class="log-list" v-else-if="displayedEntries.length > 0">
      <template v-for="(entry, idx) in displayedEntries" :key="entry.hashFull">
        <!-- Section label before first unpushed commit (or unpublished branch) -->
        <li
          v-if="!isSearchActive && effectiveAhead > 0 && idx === 0"
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
        <li v-if="!isSearchActive && !needsPublish && effectiveAhead > 0 && idx === effectiveAhead" class="log-section-label log-section-label--pushed">
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
            'commit-item--unpushed': isUnpushed(entry),
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
              <span v-if="isUnpushed(entry)" class="unpushed-badge">{{ needsPublish ? t('log.unpublishedBadge') : 'unpushed' }}</span>
            </div>
            <div v-if="reasonByHash.get(entry.hashFull)" class="commit-ai-reason">
              ✨ {{ reasonByHash.get(entry.hashFull) }}
            </div>
            <div class="commit-meta">
              <span class="commit-hash mono">{{ entry.hash }}</span>
              <span class="commit-separator" aria-hidden="true">&middot;</span>
              <span class="commit-author">{{ entry.author }}</span>
              <span class="commit-separator" aria-hidden="true">&middot;</span>
              <time class="commit-date" :datetime="entry.date">{{ relativeDate(entry.date) }}</time>
            </div>
          </div>
          <!-- Edit button — HEAD unpushed only (hidden in search mode) -->
          <button
            v-if="!isSearchActive && aheadCount != null && idx === 0"
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

/* ─── Search bar (Phase 1.3.4) ────────────────────────────── */
.log-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.log-search-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.log-search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  padding: 2px 0;
}

.log-search-input::placeholder {
  color: var(--color-text-muted);
}

.log-search-ai,
.log-search-clear {
  flex-shrink: 0;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-xs);
}

.log-search-ai {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.08));
}

.log-search-ai:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-accent-text);
}

.log-search-ai:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.log-search-clear:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
}

.log-search-error,
.log-search-status {
  margin: 0;
  padding: 6px var(--space-3);
  font-size: var(--font-size-xs);
  border-bottom: 1px solid var(--color-border);
}

.log-search-error {
  color: var(--color-danger, #ef4444);
  background: var(--color-danger-soft, rgba(239, 68, 68, 0.06));
}

.log-search-status {
  color: var(--color-accent);
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.06));
}

.commit-ai-reason {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  line-height: 1.3;
}
</style>
