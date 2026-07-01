<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { useFileExplorer } from "../composables/useFileExplorer";
import { useRepoFileTree } from "../composables/useRepoFileTree";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import type { RepoFileEntry } from "../composables/useGitRepo";

const props = defineProps<{
  repoPath: string;
  changedFiles: RepoFileEntry[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "request-close-tab", tabId: number): void;
}>();

const { t } = useI18n();
const { settings } = useSettings();
const explorer = useFileExplorer();

const repoPathRef = computed(() => props.repoPath);
const changedFilesRef = computed(() => props.changedFiles);
const tree = useRepoFileTree(repoPathRef, changedFilesRef);

onMounted(() => tree.refresh());
watch(repoPathRef, () => tree.refresh());

const tabs = computed(() => explorer.tabsFor(props.repoPath));
const activeId = computed(() => explorer.activeTabId(props.repoPath));
const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);

const mode = computed(() => settings.value.filesMode);
const fullscreen = computed(() => mode.value === "fullscreen");
const bottom = computed(() => mode.value === "bottom");

// ── Floating position/size, persisted — mirrors TerminalPanel.vue ──
const HEIGHT_KEY = "gitwand-explorer-height";
const LEFT_KEY = "gitwand-explorer-left";
const WIDTH_KEY = "gitwand-explorer-width";
const TOP_KEY = "gitwand-explorer-top";
const height = ref(Number(localStorage.getItem(HEIGHT_KEY)) || 360);
const left = ref(Number(localStorage.getItem(LEFT_KEY)) || 16);
const width = ref(Number(localStorage.getItem(WIDTH_KEY)) || 640);
const top = ref(Number(localStorage.getItem(TOP_KEY)) || 80);

const panelStyle = computed(() => {
  if (fullscreen.value || bottom.value) return {};
  return {
    left: `${left.value}px`,
    top: `${top.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
  };
});

async function onFileClick(path: string) {
  await explorer.openTab(props.repoPath, props.repoPath, path, false);
}

async function onFileDblClick(path: string) {
  await explorer.openTab(props.repoPath, props.repoPath, path, true);
}

function onTabClick(tabId: number) {
  explorer.setActive(props.repoPath, tabId);
}

function onTabClose(tabId: number) {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab && explorer.isDirty(tab)) {
    emit("request-close-tab", tabId);
  } else {
    explorer.closeTab(props.repoPath, tabId);
  }
}
</script>

<template>
  <div
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
  >
    <div class="fe__header">
      <span class="fe__title">{{ t("files.headerLabel") }}</span>
      <button v-if="tree.truncated.value" class="fe__truncated" :title="t('files.truncatedTooltip')">
        {{ t("files.truncatedBadge") }}
      </button>
      <button class="fe__close" :title="t('common.close')" @click="emit('close')">✕</button>
    </div>

    <div class="fe__body">
      <div class="fe__tree" role="tree">
        <div
          v-for="row in tree.rows.value"
          :key="`${row.kind}-${row.path}`"
          class="file-item"
          :class="{ 'tree-folder': row.kind === 'folder' }"
          :style="{ paddingLeft: `${row.depth * 14 + (row.kind === 'folder' ? 5 : 18)}px` }"
          role="treeitem"
          tabindex="0"
          @click="row.kind === 'folder' ? tree.toggleFolder(row.path) : onFileClick(row.path)"
          @dblclick="row.kind === 'file' && onFileDblClick(row.path)"
        >
          <template v-if="row.kind === 'folder'">
            <svg
              class="tree-chevron"
              :class="{ 'tree-chevron--collapsed': tree.isCollapsed(row.path) }"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 5h6l2 2h10v12H3z" />
            </svg>
            <span class="file-name mono tree-folder-name">{{ row.name }}</span>
            <span class="tree-folder-count">{{ row.count }}</span>
          </template>
          <template v-else>
            <span
              v-if="tree.statusByPath.value.get(row.path)"
              class="file-status-dot"
              :class="`file-status-dot--${tree.statusByPath.value.get(row.path)}`"
              :title="tree.statusByPath.value.get(row.path)"
            />
            <span class="file-name mono">{{ row.name }}</span>
          </template>
        </div>
      </div>

      <div class="fe__editor-pane">
        <div v-if="tabs.length" class="fe__tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="fe__tab"
            :class="{ 'fe__tab--active': tab.id === activeId, 'fe__tab--preview': !tab.pinned }"
            @click="onTabClick(tab.id)"
          >
            <span class="fe__tab-name">{{ tab.path.split('/').pop() }}</span>
            <span v-if="explorer.isDirty(tab)" class="fe__tab-dot" />
            <span class="fe__tab-close" @click.stop="onTabClose(tab.id)">✕</span>
          </button>
        </div>
        <div v-if="activeTab" class="fe__content">
          <pre class="fe__pre">{{ activeTab.content }}</pre>
        </div>
        <div v-else class="fe__empty">{{ t("files.emptyHint") }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fe {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 40;
  overflow: hidden;
}

.fe--full {
  position: static;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.fe--bottom {
  position: static;
  width: 100%;
  height: 360px;
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
}

.fe__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe__title {
  font-weight: var(--font-weight-medium);
  flex: 1;
}

.fe__close {
  color: var(--color-text-muted);
}

.fe__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.fe__tree {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
}

.fe__editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fe__tabs {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe__tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.fe__tab--active {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fe__tab--preview {
  font-style: italic;
}

.fe__tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}

.fe__content {
  flex: 1;
  overflow: auto;
}

.fe__pre {
  margin: 0;
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-base);
  white-space: pre-wrap;
}

.fe__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.file-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}

.file-status-dot--added { background: var(--color-status-added); }
.file-status-dot--modified { background: var(--color-status-modified, var(--color-accent)); }
.file-status-dot--deleted { background: var(--color-danger); }
.file-status-dot--renamed { background: var(--color-status-added); }

/* Tree row classes (.file-item, .tree-folder, .tree-chevron,
   .tree-folder-icon, .tree-folder-name, .tree-folder-count, .file-name) are
   intentionally NOT defined here — they come from the shared global rules
   added to apps/desktop/src/assets/main.css in Step 1, also used by
   RepoSidebar.vue's tree layout. Do not re-add them locally. */
</style>
