<script setup lang="ts">
import type { GlobalStats } from "../composables/useGitWand";
import type { Theme } from "../composables/useTheme";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  stats: GlobalStats;
  hasFiles: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSave: boolean;
  theme: Theme;
  appMode: "merge" | "repo";
  branchDisplay: string;
  repoStats: { staged: number; unstaged: number; untracked: number; conflicted: number };
  hasRepo: boolean;
  canPush: boolean;
  canPull: boolean;
  aheadCount: number;
  behindCount: number;
  isPushing: boolean;
  isPulling: boolean;
}>();

const emit = defineEmits<{
  openFolder: [];
  resolveAll: [];
  saveAll: [];
  undo: [];
  redo: [];
  toggleTheme: [];
  switchMode: [mode: "merge" | "repo"];
  push: [];
  pull: [];
  openSettings: [];
}>();

const isRepo = () => props.appMode === "repo";
const isMerge = () => props.appMode === "merge";
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <svg class="logo" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--color-accent)" />
        <path d="M18 14L19 17L22 18L19 19L18 22L17 19L14 18L17 17L18 14Z" fill="var(--color-warning)" opacity="0.8" />
      </svg>
      <h1 class="title">GitWand</h1>

      <!-- Mode switcher -->
      <div class="mode-switcher">
        <button
          class="mode-btn"
          :class="{ 'mode-btn--active': appMode === 'repo' }"
          @click="emit('switchMode', 'repo')"
          :title="t('header.modeRepo')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="3" r="2" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="8" cy="13" r="2" stroke="currentColor" stroke-width="1.5"/>
            <path d="M8 5v6" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          {{ t('header.modeRepo') }}
        </button>
        <button
          class="mode-btn"
          :class="{ 'mode-btn--active': appMode === 'merge' }"
          @click="emit('switchMode', 'merge')"
          :title="t('header.modeMerge')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="4" cy="3" r="2" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="12" cy="3" r="2" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="8" cy="13" r="2" stroke="currentColor" stroke-width="1.5"/>
            <path d="M4 5v2c0 2 4 4 4 4M12 5v2c0 2-4 4-4 4" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          {{ t('header.modeMerge') }}
        </button>
      </div>
    </div>

    <div class="header-center">
      <!-- Repo mode: branch + stats -->
      <template v-if="appMode === 'repo' && hasRepo">
        <div class="branch-info">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
            <path d="M5 6v4M7 4h3c1.1 0 2 .9 2 2v0" stroke="currentColor" stroke-width="1.3"/>
          </svg>
          <span class="branch-name mono">{{ branchDisplay }}</span>
        </div>
        <div class="repo-stat-group" v-if="repoStats.staged + repoStats.unstaged + repoStats.untracked + repoStats.conflicted > 0">
          <span class="repo-stat" v-if="repoStats.staged > 0">
            <span class="repo-stat-dot" style="background: var(--color-success)"></span>
            {{ repoStats.staged }} {{ t('header.staged') }}
          </span>
          <span class="repo-stat" v-if="repoStats.unstaged > 0">
            <span class="repo-stat-dot" style="background: var(--color-warning)"></span>
            {{ repoStats.unstaged }} {{ t('header.modified') }}
          </span>
          <span class="repo-stat" v-if="repoStats.untracked > 0">
            <span class="repo-stat-dot" style="background: var(--color-text-muted)"></span>
            {{ repoStats.untracked }} {{ t('header.untracked') }}
          </span>
          <span class="repo-stat" v-if="repoStats.conflicted > 0">
            <span class="repo-stat-dot" style="background: var(--color-danger)"></span>
            {{ repoStats.conflicted }} {{ t('header.conflicts') }}
          </span>
        </div>
      </template>

      <!-- Merge mode: conflict stats -->
      <template v-else-if="appMode === 'merge' && hasFiles">
        <div class="stat-group">
          <span class="stat">
            <span class="stat-value">{{ stats.totalFiles }}</span>
            <span class="stat-label">{{ stats.totalFiles === 1 ? t('header.file') : t('header.files') }}</span>
          </span>
          <span class="stat-separator" aria-hidden="true">/</span>
          <span class="stat">
            <span class="stat-value">{{ stats.totalConflicts }}</span>
            <span class="stat-label">{{ stats.totalConflicts === 1 ? t('header.conflict') : t('header.conflicts') }}</span>
          </span>
          <span class="stat-separator" aria-hidden="true">/</span>
          <span class="stat stat--success" v-if="stats.autoResolved > 0">
            <span class="stat-value">{{ stats.autoResolved }}</span>
            <span class="stat-label">{{ t('header.auto') }}</span>
          </span>
          <span class="stat stat--warning" v-if="stats.remaining > 0">
            <span class="stat-value">{{ stats.remaining }}</span>
            <span class="stat-label">{{ stats.remaining === 1 ? t('header.remaining') : t('header.remainingPlural') }}</span>
          </span>
        </div>
      </template>
    </div>

    <div class="header-right">
      <!-- Theme toggle -->
      <button
        class="btn btn--icon theme-toggle"
        @click="emit('toggleTheme')"
        :aria-label="theme === 'dark' ? t('header.themeLight') : t('header.themeDark')"
        :title="theme === 'dark' ? t('header.themeLightLabel') : t('header.themeDarkLabel')"
      >
        <svg v-if="theme === 'dark'" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13.5 9.5a5.5 5.5 0 01-7-7A5.5 5.5 0 1013.5 9.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </button>

      <!-- Settings -->
      <button
        class="btn btn--icon"
        @click="emit('openSettings')"
        :aria-label="t('settings.title')"
        :title="t('settings.title')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6.5 1.5h3l.4 1.6a5.5 5.5 0 011.3.7l1.5-.6 1.5 2.6-1.1 1a5.5 5.5 0 010 1.4l1.1 1-1.5 2.6-1.5-.6a5.5 5.5 0 01-1.3.7l-.4 1.6h-3l-.4-1.6a5.5 5.5 0 01-1.3-.7l-1.5.6-1.5-2.6 1.1-1a5.5 5.5 0 010-1.4l-1.1-1 1.5-2.6 1.5.6a5.5 5.5 0 011.3-.7l.4-1.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>

      <!-- Undo/Redo (merge mode only) -->
      <div class="undo-redo" v-if="appMode === 'merge' && hasFiles">
        <button
          class="btn btn--icon"
          :class="{ 'btn--disabled': !canUndo }"
          :disabled="!canUndo"
          @click="emit('undo')"
          :aria-label="t('header.undo')"
          :title="t('header.undo')"
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
          :aria-label="t('header.redo')"
          :title="t('header.redo')"
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
        :aria-label="t('header.openFolder')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
        <span>{{ t('header.open') }}</span>
      </button>

      <!-- Repo mode: push/pull -->
      <template v-if="appMode === 'repo' && hasRepo">
        <button
          class="btn btn--sync"
          :class="{ 'btn--disabled': !canPull, 'btn--sync-active': behindCount > 0 }"
          :disabled="!canPull"
          @click="emit('pull')"
          :title="`Pull (${behindCount})`"
        >
          <svg v-if="isPulling" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M5 10l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('header.pull') }}</span>
          <span v-if="behindCount > 0" class="sync-badge sync-badge--pull">{{ behindCount }}</span>
        </button>
        <button
          class="btn btn--sync btn--push"
          :class="{ 'btn--disabled': !canPush, 'btn--sync-active': aheadCount > 0 }"
          :disabled="!canPush"
          @click="emit('push')"
          :title="`Push (${aheadCount})`"
        >
          <svg v-if="isPushing" class="btn-spinner" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.3"/>
            <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>{{ t('header.push') }}</span>
          <span v-if="aheadCount > 0" class="sync-badge sync-badge--push">{{ aheadCount }}</span>
        </button>
      </template>

      <!-- Merge mode buttons -->
      <button
        v-if="appMode === 'merge' && hasFiles && stats.autoResolved > 0"
        class="btn btn--primary"
        @click="emit('resolveAll')"
        :aria-label="t('header.resolveAll')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/>
        </svg>
        <span>{{ t('header.resolveAll') }}</span>
      </button>
      <button
        v-if="canSave"
        class="btn btn--save"
        @click="emit('saveAll')"
        :aria-label="t('header.saveShortcut')"
        :title="t('header.saveShortcut')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M12.5 14h-9A1.5 1.5 0 012 12.5v-9A1.5 1.5 0 013.5 2H10l4 4v6.5a1.5 1.5 0 01-1.5 1.5z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <path d="M10 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          <rect x="5" y="9" width="6" height="3" rx="0.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
        </svg>
        <span>{{ t('header.save') }}</span>
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

/* Mode switcher */
.mode-switcher {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 8px;
  background: var(--color-bg);
  border-radius: 6px;
  padding: 2px;
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
  background: none;
  border-radius: 4px;
  transition: all 0.15s;
}

.mode-btn:hover {
  color: var(--color-text);
}

.mode-btn--active {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

/* Branch info */
.branch-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text);
}

.branch-name {
  font-size: 13px;
  font-weight: 500;
}

.repo-stat-group {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: 16px;
}

.repo-stat {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.repo-stat-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.header-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
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

/* Sync buttons (Push/Pull) */
.btn--sync {
  position: relative;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--sync:hover:not(:disabled) {
  background: var(--color-border);
}

.btn--sync-active {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn--push.btn--sync-active {
  background: var(--color-accent);
  color: #fff;
}

.btn--push.btn--sync-active:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.sync-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.sync-badge--push {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.sync-badge--pull {
  background: var(--color-accent);
  color: #fff;
}

.btn--save {
  background: var(--color-success);
  color: #fff;
}

.btn--save:hover {
  filter: brightness(1.1);
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

.btn-spinner {
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
