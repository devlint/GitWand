<script setup lang="ts">
import { ref, computed } from "vue";
import type { GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
const { t } = useI18n();

const props = defineProps<{
  branches: GitBranch[];
  currentBranch: string;
  loading: boolean;
}>();

const emit = defineEmits<{
  switchBranch: [name: string];
  createBranch: [name: string];
  deleteBranch: [name: string];
  refresh: [];
}>();

const newBranchName = ref("");
const showCreate = ref(false);
const filter = ref("");

const mainNames = ["main", "master"];

function branchSort(a: typeof props.branches[0], b: typeof props.branches[0]): number {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  const aName = a.name.replace(/^origin\//, "").toLowerCase();
  const bName = b.name.replace(/^origin\//, "").toLowerCase();
  const aMain = mainNames.includes(aName) ? 0 : 1;
  const bMain = mainNames.includes(bName) ? 0 : 1;
  if (aMain !== bMain) return aMain - bMain;
  if (a.lastCommitDate && b.lastCommitDate) {
    const da = new Date(a.lastCommitDate).getTime();
    const db = new Date(b.lastCommitDate).getTime();
    if (da !== db) return db - da;
  }
  return a.name.localeCompare(b.name);
}

const localBranches = computed(() =>
  props.branches
    .filter((b) => !b.isRemote)
    .filter((b) => !filter.value || b.name.toLowerCase().includes(filter.value.toLowerCase()))
    .sort(branchSort),
);

const remoteBranches = computed(() =>
  props.branches
    .filter((b) => b.isRemote)
    .filter((b) => !filter.value || b.name.toLowerCase().includes(filter.value.toLowerCase()))
    .sort(branchSort),
);

function handleCreate() {
  const name = newBranchName.value.trim();
  if (!name) return;
  emit("createBranch", name);
  newBranchName.value = "";
  showCreate.value = false;
}

function handleCreateKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    handleCreate();
  } else if (e.key === "Escape") {
    showCreate.value = false;
    newBranchName.value = "";
  }
}
</script>

<template>
  <div class="branch-panel">
    <div class="branch-header">
      <span class="branch-title">{{ t('branches.title') }}</span>
      <div class="branch-actions">
        <button class="branch-action-btn" @click="emit('refresh')" :title="t('common.refresh')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M1 8a7 7 0 0112.95-3.64M15 8a7 7 0 01-12.95 3.64" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M14 1v4h-4M2 15v-4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="branch-action-btn" @click="showCreate = !showCreate" :title="t('branches.create')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Create branch form -->
    <div class="create-form" v-if="showCreate">
      <input
        class="create-input mono"
        v-model="newBranchName"
        @keydown="handleCreateKeydown"
        :placeholder="t('branches.namePlaceholder')"
        autofocus
      />
      <button
        class="create-btn"
        :disabled="!newBranchName.trim()"
        @click="handleCreate"
      >{{ t('common.create') }}</button>
    </div>

    <!-- Filter -->
    <div class="branch-filter" v-if="localBranches.length + remoteBranches.length > 5">
      <input
        class="filter-input"
        v-model="filter"
        :placeholder="t('branches.filter')"
      />
    </div>

    <div class="branch-loading" v-if="loading">
      <div class="loading-spinner"></div>
    </div>

    <div class="branch-lists" v-else>
      <!-- Local branches -->
      <div class="branch-section" v-if="localBranches.length > 0">
        <div class="branch-section-label">{{ t('branches.local') }}</div>
        <ul class="branch-list">
          <li
            v-for="branch in localBranches"
            :key="branch.name"
            class="branch-item"
            :class="{ 'branch-item--current': branch.isCurrent }"
          >
            <span class="branch-current-dot" v-if="branch.isCurrent"></span>
            <div class="branch-item-info">
              <span class="branch-item-name mono">{{ branch.name }}</span>
              <span class="branch-item-meta muted" v-if="branch.ahead > 0 || branch.behind > 0">
                <span v-if="branch.ahead > 0">&uarr;{{ branch.ahead }}</span>
                <span v-if="branch.behind > 0">&darr;{{ branch.behind }}</span>
              </span>
            </div>
            <div class="branch-item-actions" v-if="!branch.isCurrent">
              <button
                class="branch-item-btn"
                @click="emit('switchBranch', branch.name)"
                :title="t('branches.switch')"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 12l4-4-4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button
                class="branch-item-btn branch-item-btn--danger"
                @click="emit('deleteBranch', branch.name)"
                :title="t('branches.deleteLabel')"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          </li>
        </ul>
      </div>

      <!-- Remote branches -->
      <div class="branch-section" v-if="remoteBranches.length > 0">
        <div class="branch-section-label">{{ t('branches.remote') }}</div>
        <ul class="branch-list">
          <li
            v-for="branch in remoteBranches"
            :key="branch.name"
            class="branch-item branch-item--remote"
          >
            <div class="branch-item-info">
              <span class="branch-item-name mono">{{ branch.name }}</span>
            </div>
            <button
              class="branch-item-btn"
              @click="emit('switchBranch', branch.name.replace(/^origin\//, ''))"
              :title="t('branches.switch')"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 12l4-4-4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </li>
        </ul>
      </div>

      <div class="branch-empty" v-if="localBranches.length === 0 && remoteBranches.length === 0">
        <span class="muted">{{ t('branches.noBranch') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.branch-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.branch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.branch-title {
  font-size: 13px;
  font-weight: 600;
}

.branch-actions {
  display: flex;
  gap: 4px;
}

.branch-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  color: var(--color-text-muted);
  background: none;
  transition: background 0.1s, color 0.1s;
}

.branch-action-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.create-form {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
}

.create-input {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  outline: none;
}

.create-input:focus {
  border-color: var(--color-accent);
}

.create-btn {
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  background: var(--color-accent);
  color: #fff;
  border-radius: 4px;
  transition: background 0.15s;
}

.create-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.create-btn:disabled {
  opacity: 0.4;
}

.branch-filter {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
}

.filter-input {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  outline: none;
}

.filter-input:focus {
  border-color: var(--color-accent);
}

.branch-loading {
  display: flex;
  align-items: center;
  justify-content: center;
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

.branch-lists {
  flex: 1;
  overflow-y: auto;
}

.branch-section {
  border-bottom: 1px solid var(--color-border);
}

.branch-section-label {
  padding: 6px 14px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  background: var(--color-bg);
}

.branch-list {
  list-style: none;
}

.branch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  transition: background 0.1s;
}

.branch-item:hover {
  background: var(--color-bg-tertiary);
}

.branch-item--current {
  background: var(--color-bg-tertiary);
}

.branch-current-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}

.branch-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.branch-item-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-item--remote .branch-item-name {
  opacity: 0.7;
}

.branch-item-meta {
  font-size: 10px;
  flex-shrink: 0;
}

.branch-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s;
}

.branch-item:hover .branch-item-actions {
  opacity: 1;
}

.branch-item-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--color-text-muted);
  background: none;
  transition: background 0.1s, color 0.1s;
}

.branch-item-btn:hover {
  background: var(--color-bg);
  color: var(--color-text);
}

.branch-item-btn--danger:hover {
  color: var(--color-danger);
}

.branch-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px;
}
</style>
