<script setup lang="ts">
import { computed } from "vue";
import type { GitLogEntry } from "../utils/backend";

const props = defineProps<{
  entries: GitLogEntry[];
  loading: boolean;
  selectedHash: string | null;
}>();

const emit = defineEmits<{
  selectCommit: [hash: string];
}>();

function relativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "maintenant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  if (diffHour < 24) return `il y a ${diffHour}h`;
  if (diffDay < 7) return `il y a ${diffDay}j`;
  if (diffDay < 30) return `il y a ${Math.floor(diffDay / 7)} sem.`;
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
      <span class="muted">Chargement...</span>
    </div>

    <ul class="log-list" v-else-if="entries.length > 0">
      <li
        v-for="entry in entries"
        :key="entry.hashFull"
        class="commit-item"
        :class="{ 'commit-item--selected': selectedHash === entry.hashFull }"
        @click="emit('selectCommit', entry.hashFull)"
        tabindex="0"
        @keydown.enter="emit('selectCommit', entry.hashFull)"
      >
        <div class="commit-avatar" :style="{ background: authorColor(entry.author) }">
          {{ authorInitials(entry.author) }}
        </div>
        <div class="commit-info">
          <div class="commit-message">{{ entry.message }}</div>
          <div class="commit-meta">
            <span class="commit-hash mono">{{ entry.hash }}</span>
            <span class="commit-separator" aria-hidden="true">&middot;</span>
            <span class="commit-author">{{ entry.author }}</span>
            <span class="commit-separator" aria-hidden="true">&middot;</span>
            <time class="commit-date" :datetime="entry.date">{{ relativeDate(entry.date) }}</time>
          </div>
        </div>
      </li>
    </ul>

    <div class="log-empty" v-else>
      <span class="muted">Aucun commit</span>
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
  gap: 10px;
  padding: 30px;
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

.commit-item {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background 0.1s;
  border-left: 3px solid transparent;
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

.commit-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  margin-top: 2px;
}

.commit-info {
  flex: 1;
  min-width: 0;
}

.commit-message {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.commit-hash {
  font-size: 11px;
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
  padding: 40px;
}
</style>
