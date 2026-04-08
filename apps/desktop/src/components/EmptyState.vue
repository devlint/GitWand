<script setup lang="ts">
import { computed } from "vue";
import { useFolderHistory } from "../composables/useFolderHistory";
import { useI18n } from "../composables/useI18n";

const emit = defineEmits<{
  openFolder: [];
  openPath: [path: string];
}>();

const { history } = useFolderHistory();
const { t } = useI18n();

const recentFolders = computed(() => history.value.slice(0, 5));

const isMac = navigator.platform.toUpperCase().includes("MAC");
</script>

<template>
  <div class="empty-state" role="status">
    <div class="empty-visual" aria-hidden="true">
      <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
        <circle cx="40" cy="40" r="36" stroke="var(--color-border)" stroke-width="2" stroke-dasharray="6 4" />
        <path d="M40 18L43 28.5L53 31L43 33.5L40 44L37 33.5L27 31L37 28.5L40 18Z" fill="var(--color-accent)" opacity="0.6" />
        <path d="M54 38L56 43L61 45L56 47L54 52L52 47L47 45L52 43L54 38Z" fill="var(--color-warning)" opacity="0.4" />
        <path d="M28 42L29.5 46L33 47.5L29.5 49L28 53L26.5 49L23 47.5L26.5 46L28 42Z" fill="var(--color-theirs)" opacity="0.4" />
      </svg>
    </div>

    <h2 class="empty-title">{{ t('empty.title') }}</h2>
    <p class="empty-desc muted">{{ t('empty.subtitle') }}</p>

    <button
      class="empty-btn"
      @click="emit('openFolder')"
      :aria-label="t('empty.openButton')"
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      </svg>
      {{ t('empty.openButton') }}
    </button>

    <!-- Recent folders -->
    <div v-if="recentFolders.length > 0" class="recent-section">
      <span class="recent-label muted">{{ t('empty.recentTitle') }}</span>
      <ul class="recent-list">
        <li
          v-for="entry in recentFolders"
          :key="entry.path"
          class="recent-item"
          @click="emit('openPath', entry.path)"
        >
          <svg
            v-if="entry.pinned"
            class="recent-star"
            width="12" height="12"
            viewBox="0 0 12 12"
            fill="#fbbf24"
            aria-hidden="true"
          >
            <path d="M6 1l1.5 3 3.5.5-2.5 2.5.5 3.5L6 9l-3 1.5.5-3.5L1 4.5 4.5 4 6 1z" stroke-linejoin="round"/>
          </svg>
          <svg
            v-else
            class="recent-icon"
            width="12" height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M1 3.5A1.5 1.5 0 012.5 2h2.764c.58 0 1.13.237 1.53.659l.74.815A1.5 1.5 0 008.58 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/>
          </svg>
          <span class="recent-name">{{ entry.name }}</span>
          <span class="recent-path muted">{{ entry.path }}</span>
        </li>
      </ul>
    </div>

    <div class="empty-hint muted">
      <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd> + <kbd>K</kbd> pour ouvrir rapidement
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  padding: 40px;
  text-align: center;
}

.empty-visual {
  margin-bottom: 8px;
  animation: float 4s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
}

.empty-desc {
  font-size: 14px;
  line-height: 1.6;
  max-width: 320px;
}

.empty-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  background: var(--color-accent);
  color: #fff;
  transition: background 0.15s, transform 0.1s;
  margin-top: 8px;
}

.empty-btn:hover {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
}

.empty-btn:active {
  transform: translateY(0);
}

/* ─── Recent folders ──────────────────────────────────── */

.recent-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  width: 100%;
  max-width: 400px;
}

.recent-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.recent-list {
  list-style: none;
  width: 100%;
  margin: 0;
  padding: 0;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
  text-align: left;
}

.recent-item:hover {
  background: var(--color-bg-tertiary);
}

.recent-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.recent-star {
  flex-shrink: 0;
}

.recent-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.recent-path {
  flex: 1;
  font-size: 11px;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ─── Hint ────────────────────────────────────────────── */

.empty-hint {
  font-size: 12px;
  margin-top: 8px;
}

.empty-hint kbd {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
}
</style>
