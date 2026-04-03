<script setup lang="ts">
import type { GlobalStats } from "../composables/useGitWand";
import type { Theme } from "../composables/useTheme";

const props = defineProps<{
  stats: GlobalStats;
  hasFiles: boolean;
  canUndo: boolean;
  canRedo: boolean;
  theme: Theme;
}>();

const emit = defineEmits<{
  openFolder: [];
  resolveAll: [];
  undo: [];
  redo: [];
  toggleTheme: [];
}>();
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <svg class="logo" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--color-accent)" />
        <path d="M18 14L19 17L22 18L19 19L18 22L17 19L14 18L17 17L18 14Z" fill="var(--color-warning)" opacity="0.8" />
      </svg>
      <h1 class="title">GitWand</h1>
    </div>

    <div class="header-center" v-if="hasFiles">
      <div class="stat-group">
        <span class="stat">
          <span class="stat-value">{{ stats.totalFiles }}</span>
          <span class="stat-label">{{ stats.totalFiles === 1 ? 'fichier' : 'fichiers' }}</span>
        </span>
        <span class="stat-separator" aria-hidden="true">/</span>
        <span class="stat">
          <span class="stat-value">{{ stats.totalConflicts }}</span>
          <span class="stat-label">{{ stats.totalConflicts === 1 ? 'conflit' : 'conflits' }}</span>
        </span>
        <span class="stat-separator" aria-hidden="true">/</span>
        <span class="stat stat--success" v-if="stats.autoResolved > 0">
          <span class="stat-value">{{ stats.autoResolved }}</span>
          <span class="stat-label">auto</span>
        </span>
        <span class="stat stat--warning" v-if="stats.remaining > 0">
          <span class="stat-value">{{ stats.remaining }}</span>
          <span class="stat-label">{{ stats.remaining === 1 ? 'restant' : 'restants' }}</span>
        </span>
      </div>
    </div>

    <div class="header-right">
      <!-- Theme toggle -->
      <button
        class="btn btn--icon theme-toggle"
        @click="emit('toggleTheme')"
        :aria-label="theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'"
        :title="theme === 'dark' ? 'Mode clair' : 'Mode sombre'"
      >
        <!-- Sun (shown in dark mode → click to go light) -->
        <svg v-if="theme === 'dark'" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <!-- Moon (shown in light mode → click to go dark) -->
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13.5 9.5a5.5 5.5 0 01-7-7A5.5 5.5 0 1013.5 9.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </button>

      <div class="undo-redo" v-if="hasFiles">
        <button
          class="btn btn--icon"
          :class="{ 'btn--disabled': !canUndo }"
          :disabled="!canUndo"
          @click="emit('undo')"
          aria-label="Annuler (Ctrl+Z)"
          title="Annuler (Ctrl+Z)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h8a3 3 0 010 6H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5 5L3 8l2 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </button>
        <button
          class="btn btn--icon"
          :class="{ 'btn--disabled': !canRedo }"
          :disabled="!canRedo"
          @click="emit('redo')"
          aria-label="Rétablir (Ctrl+Shift+Z)"
          title="Rétablir (Ctrl+Shift+Z)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13 8H5a3 3 0 000 6h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M11 5l2 3-2 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </button>
      </div>
      <button
        class="btn btn--secondary"
        @click="emit('openFolder')"
        aria-label="Ouvrir un dossier"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
        <span>Ouvrir</span>
      </button>
      <button
        v-if="hasFiles && stats.autoResolved > 0"
        class="btn btn--primary"
        @click="emit('resolveAll')"
        aria-label="Résoudre tous les conflits automatiques"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/>
        </svg>
        <span>Tout résoudre</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 16px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  gap: 16px;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo {
  flex-shrink: 0;
}

.title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.header-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.stat-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
}

.stat-value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-label {
  color: var(--color-text-muted);
}

.stat-separator {
  color: var(--color-border);
}

.stat--success .stat-value {
  color: var(--color-success);
}

.stat--warning .stat-value {
  color: var(--color-warning);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
}

.btn--secondary {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--secondary:hover {
  background: var(--color-border);
}

.btn--primary {
  background: var(--color-accent);
  color: #fff;
}

.btn--primary:hover {
  background: var(--color-accent-hover);
}

.undo-redo {
  display: flex;
  align-items: center;
  gap: 2px;
}

.btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  transition: background 0.12s, color 0.12s;
}

.btn--icon:hover:not(:disabled) {
  background: var(--color-border);
}

.btn--icon:disabled,
.btn--disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
</style>
