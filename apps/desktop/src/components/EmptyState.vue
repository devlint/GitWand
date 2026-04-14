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
      <!-- Full GitWand logo: cube + code icon left + git graph right -->
      <svg width="210" height="84" viewBox="0 0 300 120" fill="none">
        <!-- signal wave -->
        <path d="M 10,58 L 22,58 L 26,42 L 30,74 L 34,52 L 38,58 L 52,58"
              stroke="#7C3AED" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>
        <circle cx="72" cy="58" r="3.5" fill="#7C3AED" opacity="0.75"/>
        <line x1="52" y1="58" x2="112" y2="58" stroke="#7C3AED" stroke-width="1.5" opacity="0.75"/>
        <text x="72" y="78" font-family="'Courier New', monospace"
              font-size="10" font-weight="700" fill="#7C3AED" text-anchor="middle" opacity="0.75">&lt;/&gt;</text>
        <!-- cube back wall -->
        <path d="M 171,60 L 161,42.7 L 141,42.7 L 131,60 L 141,77.3 L 161,77.3 Z" fill="none"/>
        <!-- cube top face -->
        <path d="M 111,60 L 131,25.4 L 171,25.4 L 191,60 L 171,60 L 161,42.7 L 141,42.7 L 131,60 Z" fill="#8B5CF6"/>
        <!-- cube lower-right -->
        <path d="M 191,60 L 171,94.6 L 161,77.3 L 171,60 Z" fill="#4C1D95"/>
        <!-- cube lower-left -->
        <path d="M 111,60 L 131,60 L 141,77.3 L 131,94.6 Z" fill="#6D28D9"/>
        <!-- cube bottom -->
        <path d="M 131,94.6 L 171,94.6 L 161,77.3 L 141,77.3 Z" fill="#5B21B6"/>
        <!-- green line + dots -->
        <line x1="191" y1="60" x2="288" y2="60" stroke="#10B981" stroke-width="1.5" opacity="0.75"/>
        <circle cx="214" cy="60" r="4.5" fill="#10B981" opacity="0.75"/>
        <circle cx="248" cy="60" r="4.5" fill="#10B981" opacity="0.75"/>
        <circle cx="282" cy="60" r="4.5" fill="#10B981" opacity="0.75"/>
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

    <!-- Recent repos -->
    <div v-if="recentFolders.length > 0" class="recent-section">
      <span class="recent-label muted">{{ t('empty.recentTitle') }}</span>
      <div class="recent-cards">
        <button
          v-for="entry in recentFolders"
          :key="entry.path"
          class="recent-card"
          @click="emit('openPath', entry.path)"
          :title="entry.path"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
            <path d="M5 6v4M7 4h3c1.1 0 2 .9 2 2v0" stroke="currentColor" stroke-width="1.3"/>
          </svg>
          <span class="recent-card-name">{{ entry.name }}</span>
        </button>
      </div>
    </div>

    <div class="empty-hint muted">
      <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd> + <kbd>K</kbd> {{ t('empty.shortcut') }}
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
  gap: var(--space-6);
  padding: var(--space-10);
  text-align: center;
}

.empty-visual {
  margin-bottom: var(--space-4);
  animation: float 4s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50%     { transform: translateY(-6px); }
}

.empty-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
}

.empty-desc {
  font-size: var(--font-size-lg);
  line-height: var(--line-height-normal);
  max-width: 360px;
}

.empty-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-8);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  background: var(--color-accent);
  color: var(--color-accent-text);
  transition: background var(--transition-base), transform var(--transition-fast), box-shadow var(--transition-base);
  margin-top: var(--space-4);
  box-shadow: var(--shadow-sm);
}

.empty-btn:hover {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.empty-btn:active { transform: translateY(0); box-shadow: var(--shadow-xs); }

/* ─── Recent repos ───────────────────────────────────── */

.recent-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  margin-top: var(--space-6);
}

.recent-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.recent-cards {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  justify-content: center;
  max-width: 560px;
}

.recent-card {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: border-color var(--transition-base), background var(--transition-base), box-shadow var(--transition-base), transform var(--transition-fast);
}

.recent-card:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
  box-shadow: var(--shadow-xs);
  transform: translateY(-1px);
}

.recent-card svg {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.recent-card:hover svg { color: var(--color-accent); }
.recent-card:hover .recent-card-name { color: var(--color-accent); }

.recent-card-name { white-space: nowrap; }

/* ─── Hint ────────────────────────────────────────────── */

.empty-hint {
  font-size: var(--font-size-base);
  margin-top: var(--space-4);
}

.empty-hint kbd {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
</style>
