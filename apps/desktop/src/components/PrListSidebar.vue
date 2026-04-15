<script setup lang="ts">
/**
 * PrListSidebar.vue
 *
 * Compact PR list rendered inside RepoSidebar when viewMode === "prs".
 * Injects the shared usePrPanel state via provide/inject.
 */
import { inject, onMounted } from "vue";
import { PR_PANEL_KEY, type PrPanelState } from "../composables/usePrPanel";

const panel = inject<PrPanelState>(PR_PANEL_KEY)!;

onMounted(() => {
  panel.init();
});

function stateChip(state: string) {
  const s = state.toUpperCase();
  if (s === "OPEN") return { label: "Open", cls: "pls-chip--open" };
  if (s === "MERGED") return { label: "Merged", cls: "pls-chip--merged" };
  return { label: "Closed", cls: "pls-chip--closed" };
}
</script>

<template>
  <div class="pls-root">
    <!-- Header -->
    <div class="pls-header">
      <span class="pls-title">Pull Requests</span>
      <select v-model="panel.filterState.value" class="pls-filter" @change="panel.loadPrs">
        <option value="open">Ouvertes</option>
        <option value="closed">Fermées</option>
        <option value="all">Toutes</option>
      </select>
      <button class="pls-refresh" @click="panel.loadPrs" title="Rafraîchir">↺</button>
    </div>

    <!-- New PR button — opens the full creation view in the main area -->
    <button
      class="pls-new-btn"
      :class="{ 'pls-new-btn--active': panel.showCreateForm.value }"
      @click="panel.showCreateForm.value = true"
    >
      + Nouvelle PR
    </button>

    <!-- Messages -->
    <div v-if="panel.error.value" class="pls-msg pls-msg--error">{{ panel.error.value }}</div>
    <div v-if="panel.success.value" class="pls-msg pls-msg--success" @click="panel.success.value = null">{{ panel.success.value }}</div>

    <!-- List -->
    <div v-if="panel.loading.value" class="pls-placeholder">Chargement…</div>
    <div v-else-if="panel.prs.value.length === 0" class="pls-placeholder">Aucune PR trouvée.</div>
    <div v-else class="pls-list">
      <button
        v-for="pr in panel.prs.value"
        :key="pr.number"
        class="pls-item"
        :class="{ 'pls-item--active': panel.selectedPr.value?.number === pr.number }"
        @click="panel.selectPr(pr)"
      >
        <div class="pls-item-top">
          <span class="pls-num">#{{ pr.number }}</span>
          <span class="pls-chip" :class="stateChip(pr.state).cls">{{ stateChip(pr.state).label }}</span>
          <span v-if="pr.draft" class="pls-chip pls-chip--draft">Draft</span>
          <span class="pls-time">{{ panel.timeAgo(pr.updatedAt || pr.createdAt) }}</span>
        </div>
        <div class="pls-item-title">{{ pr.title }}</div>
        <div class="pls-item-meta">
          <span class="pls-author">{{ pr.author }}</span>
          <span class="pls-branch mono">{{ pr.branch }} → {{ pr.base }}</span>
        </div>
        <div class="pls-item-stats">
          <span class="pls-add">+{{ pr.additions }}</span>
          <span class="pls-del"> -{{ pr.deletions }}</span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pls-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.pls-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 4px;
  flex-shrink: 0;
}

.pls-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex: 1;
}

.pls-filter {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  font-size: 11px;
  padding: 2px 6px;
  cursor: pointer;
}

.pls-refresh {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.pls-refresh:hover { color: var(--color-text); background: var(--color-bg-tertiary); }

.pls-new-btn {
  margin: 0 8px 8px;
  background: var(--color-accent);
  border: none;
  border-radius: 5px;
  color: var(--color-accent-text);
  font-size: 11px;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
  flex-shrink: 0;
}
.pls-new-btn:hover { filter: brightness(1.1); }
.pls-new-btn--active {
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}

/* Messages */
.pls-msg {
  margin: 0 8px 4px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  flex-shrink: 0;
}
.pls-msg--error { background: var(--color-danger-soft); color: var(--color-danger); }
.pls-msg--success { background: var(--color-success-soft); color: var(--color-success); cursor: pointer; }

/* Placeholder */
.pls-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 24px;
}

/* List */
.pls-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 4px 8px;
}

.pls-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  background: transparent;
  color: var(--color-text);
  transition: background 0.1s, border-color 0.1s;
  width: 100%;
}
.pls-item:hover { background: var(--color-bg-tertiary); }
.pls-item--active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}

.pls-item-top {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pls-num {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-accent);
  font-family: monospace;
}

.pls-chip {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid;
}
.pls-chip--open { background: var(--color-success-soft); color: var(--color-success); border-color: var(--color-success); }
.pls-chip--merged { background: var(--color-accent-soft); color: var(--color-accent); border-color: var(--color-accent); }
.pls-chip--closed { background: var(--color-danger-soft); color: var(--color-danger); border-color: var(--color-danger); }
.pls-chip--draft { background: var(--color-bg-tertiary); color: var(--color-text-muted); border-color: var(--color-border); }

.pls-time {
  font-size: 10px;
  color: var(--color-text-muted);
  margin-left: auto;
}

.pls-item-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pls-item-meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: var(--color-text-muted);
  overflow: hidden;
}

.pls-author { flex-shrink: 0; }

.pls-branch {
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pls-item-stats {
  font-size: 10px;
  font-weight: 600;
}

.pls-add { color: var(--color-success); }
.pls-del { color: var(--color-danger); }
</style>
