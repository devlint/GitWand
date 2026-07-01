<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useFileExplorer, resolveFileExplorerShortcut, type FileTab } from "../composables/useFileExplorer";
import { useRepoFileTree } from "../composables/useRepoFileTree";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import type { RepoFileEntry } from "../composables/useGitRepo";
import type { EditorView as EditorViewType } from "@codemirror/view";
import type { EditorState as EditorStateType } from "@codemirror/state";

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

// ── CodeMirror 6 (lazy-loaded, one EditorView with per-tab cached EditorState) ──
const editorHost = ref<HTMLElement | null>(null);
let view: EditorViewType | null = null;
let EditorViewCtor: typeof import("@codemirror/view").EditorView | null = null;
let EditorStateCtor: typeof import("@codemirror/state").EditorState | null = null;
let basicSetup: any = null;
let oneDark: any = null;
const docStates = new Map<number, EditorStateType>();

async function ensureCodeMirrorLibs() {
  if (EditorViewCtor) return;
  const [{ EditorView }, { EditorState }, cmMeta, { oneDark: theme }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("codemirror"),
    import("@codemirror/theme-one-dark"),
  ]);
  EditorViewCtor = EditorView;
  EditorStateCtor = EditorState;
  basicSetup = (cmMeta as any).basicSetup;
  oneDark = theme;
}

async function detectLanguageExtension(path: string) {
  const [{ languages }, { LanguageDescription }] = await Promise.all([
    import("@codemirror/language-data"),
    import("@codemirror/language"),
  ]);
  const desc = LanguageDescription.matchFilename(languages, path);
  if (!desc) return [];
  try {
    return [await desc.load()];
  } catch {
    return [];
  }
}

function updateListenerFor(tabId: number) {
  return EditorViewCtor!.updateListener.of((update) => {
    if (!update.docChanged) return;
    docStates.set(tabId, update.state);
    explorer.updateContent(props.repoPath, tabId, update.state.doc.toString());
  });
}

async function mountTab(tab: FileTab) {
  if (tab.binary) {
    // Binary files get a placeholder (see FileTab.binary) — tear down any
    // mounted editor so a previously-open text tab's view doesn't linger.
    view?.destroy();
    view = null;
    return;
  }

  await ensureCodeMirrorLibs();
  await nextTick();
  if (!editorHost.value) return;

  let state = docStates.get(tab.id);
  if (!state) {
    const langExt = await detectLanguageExtension(tab.path);
    state = EditorStateCtor!.create({
      doc: tab.content,
      extensions: [basicSetup, oneDark, langExt, updateListenerFor(tab.id)],
    });
    docStates.set(tab.id, state);
  }

  if (!view) {
    view = new EditorViewCtor!({ state, parent: editorHost.value });
  } else {
    view.setState(state);
  }
}

watch(activeTab, (tab) => {
  if (tab) mountTab(tab);
});

watch(
  () => tabs.value.map((t) => t.id),
  (ids, oldIds) => {
    for (const id of oldIds ?? []) {
      if (!ids.includes(id)) docStates.delete(id);
    }
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

function onKeyDown(e: KeyboardEvent) {
  const shortcut = resolveFileExplorerShortcut(e, true);
  if (!shortcut || !activeTab.value) return;
  if (shortcut === "save") {
    e.preventDefault();
    if (!activeTab.value.binary) explorer.saveTab(props.repoPath, props.repoPath, activeTab.value.id);
  } else if (shortcut === "close") {
    e.preventDefault();
    onTabClose(activeTab.value.id);
  } else if (typeof shortcut === "object") {
    const target = tabs.value[shortcut.switch];
    if (target) onTabClick(target.id);
  }
}
</script>

<template>
  <div
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
    tabindex="0"
    @keydown="onKeyDown"
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
        <div v-show="activeTab && !activeTab.binary" class="fe__content" ref="editorHost"></div>
        <div v-if="activeTab && activeTab.binary" class="fe__empty">{{ t("files.binaryPlaceholder") }}</div>
        <div v-if="!activeTab" class="fe__empty">{{ t("files.emptyHint") }}</div>
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

.fe__content :deep(.cm-editor) {
  height: 100%;
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
