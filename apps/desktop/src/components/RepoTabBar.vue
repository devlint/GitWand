<script setup lang="ts">
import { computed } from "vue";
import type { RepoTab } from "../composables/useRepoTabs";

const props = defineProps<{
  tabs: RepoTab[];
  activeTabId: number | null;
}>();

const emit = defineEmits<{
  switchTab: [tabId: number];
  closeTab: [tabId: number];
  newTab: [];
  closeOtherTabs: [tabId: number];
}>();

const showTabs = computed(() => props.tabs.length > 1);

function onMiddleClick(e: MouseEvent, tabId: number) {
  if (e.button === 1) {
    e.preventDefault();
    emit("closeTab", tabId);
  }
}

function onCloseClick(e: MouseEvent, tabId: number) {
  e.stopPropagation();
  emit("closeTab", tabId);
}
</script>

<template>
  <div class="tab-bar" v-if="showTabs">
    <div class="tab-list">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ 'tab--active': tab.id === activeTabId }"
        @click="emit('switchTab', tab.id)"
        @mousedown="(e) => onMiddleClick(e, tab.id)"
        :title="tab.path"
      >
        <svg class="tab-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 013.5 2h3.586a1.5 1.5 0 011.06.44l.915.914a1 1 0 00.707.293H12.5A1.5 1.5 0 0114 5.147V12.5A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.2"/>
        </svg>
        <span class="tab-name">{{ tab.name }}</span>
        <button
          class="tab-close"
          @click="(e) => onCloseClick(e, tab.id)"
          aria-label="Close tab"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
            <path d="M2.354 2.354a.5.5 0 01.707 0L5 4.293l1.94-1.94a.5.5 0 01.706.708L5.707 5l1.94 1.94a.5.5 0 01-.707.706L5 5.707l-1.94 1.94a.5.5 0 01-.706-.707L4.293 5l-1.94-1.94a.5.5 0 010-.706z"/>
          </svg>
        </button>
      </div>
    </div>

    <button class="tab-new" @click="emit('newTab')" title="Open new repo tab">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <path d="M7 1.5a.5.5 0 01.5.5v4.5H12a.5.5 0 010 1H7.5V12a.5.5 0 01-1 0V7.5H2a.5.5 0 010-1h4.5V2a.5.5 0 01.5-.5z"/>
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ─── Tab bar — pill-style, inspired by segmented controls ─── */
.tab-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  height: var(--tabbar-height);
  flex-shrink: 0;
  padding: 0 var(--space-5);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.tab-list {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.tab {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--transition-base), background var(--transition-base);
  max-width: 200px;
  min-width: 0;
  flex-shrink: 1;
  user-select: none;
}

.tab:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.tab--active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.tab-icon {
  flex-shrink: 0;
  opacity: 0.65;
}

.tab--active .tab-icon {
  opacity: 1;
  color: var(--color-accent);
}

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tab-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  padding: 0;
}

.tab:hover .tab-close,
.tab--active .tab-close {
  opacity: 0.7;
}

.tab-close:hover {
  opacity: 1 !important;
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.tab-new {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
  margin-left: auto;
}

.tab-new:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
</style>
