<script setup lang="ts">
import { computed, ref, toRef, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useFileExplorer, resolveFileExplorerShortcut, type FileTab } from "../composables/useFileExplorer";
import { useRepoFileTree } from "../composables/useRepoFileTree";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import { useDraggableResizable } from "../composables/useDraggableResizable";
import type { RepoFileEntry } from "../composables/useGitRepo";
import { getGitBlame } from "../utils/backend";
import { buildBlameModel, type BlameGutterEntry } from "../composables/useBlameGutter";
import type { EditorView as EditorViewType } from "@codemirror/view";
import type { EditorState as EditorStateType, Extension } from "@codemirror/state";

const props = defineProps<{
  repoPath: string;
  changedFiles: RepoFileEntry[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "request-close-tab", tabId: number): void;
}>();

const { t } = useI18n();
const { settings, saveSettings } = useSettings();
const explorer = useFileExplorer();

const repoPathRef = toRef(props, "repoPath");
const changedFilesRef = toRef(props, "changedFiles");
const tree = useRepoFileTree(repoPathRef, changedFilesRef);

watch(repoPathRef, () => tree.refresh(), { immediate: true });

const tabs = computed(() => explorer.tabsFor(props.repoPath));
const activeId = computed(() => explorer.activeTabId(props.repoPath));
const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);

const mode = computed(() => settings.value.filesMode);
const fullscreen = computed(() => mode.value === "fullscreen");
const bottom = computed(() => mode.value === "bottom");

// The inline header button toggles fullscreen on/off, restoring the layout
// that was active before fullscreen (floating or bottom) on the way out —
// mirrors TerminalPanel.vue's toggleFullscreen exactly.
function toggleFullscreen() {
  if (fullscreen.value) {
    settings.value.filesMode = settings.value.filesPrevMode;
  } else {
    settings.value.filesPrevMode = mode.value as "floating" | "bottom";
    settings.value.filesMode = "fullscreen";
  }
  saveSettings(settings.value);
}

// ── Floating position/size, persisted — via the shared useDraggableResizable
// composable (also used by TerminalPanel.vue). Defaults: docked to the left
// edge, directly under the header (app-body already excludes the header, so
// top:0 lands there for free), full height of the container measured on
// mount (0 is a "not yet set" sentinel — see the onMounted block below).
const feRef = ref<HTMLElement | null>(null);

const {
  height, left, width, top,
  isDragging, isResizingX, isResizingL, isResizingBottom, resizingCorner,
  onDragStart, onMoveStart, onResizeXStart, onResizeLeftStart, onResizeBottomStart, onResizeCornerStart,
} = useDraggableResizable({
  panelRef: feRef,
  keyPrefix: "gitwand-explorer",
  initialHeight: Number(localStorage.getItem("gitwand-explorer-height")) || 0,
  initialLeft: Number(localStorage.getItem("gitwand-explorer-left")) || 0,
  initialWidth: Number(localStorage.getItem("gitwand-explorer-width")) || 0,
  initialTop: Number(localStorage.getItem("gitwand-explorer-top")) || 0,
  canMove: () => !bottom.value,
});

onMounted(() => {
  const parent = feRef.value?.parentElement;
  if (!width.value) {
    width.value = Math.round((parent?.offsetWidth ?? window.innerWidth) * 0.5);
  }
  if (!height.value) {
    height.value = parent?.offsetHeight ?? window.innerHeight;
  }
});

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
let basicSetup: Extension | null = null;
let oneDark: Extension | null = null;
let undoCommand: typeof import("@codemirror/commands").undo | null = null;
const docStates = new Map<number, EditorStateType>();
// Global (not per-tab) editable toggle — a single Compartment shared by every
// tab's EditorState, reconfigured whenever a tab is mounted/switched to so
// editability always reflects the current `editLocked` value even for a tab
// whose cached state predates the last lock toggle.
let editableCompartment: InstanceType<typeof import("@codemirror/state").Compartment> | null = null;
const editLocked = ref(true);

// ── Blame gutter (opt-in, per tab) ──
// A shared Compartment (like editableCompartment) holds either an empty
// extension (blame off) or a gutter built from the active tab's blame model.
// Blame data is fetched once per tab via getGitBlame and cached in blameModels;
// it reflects the *committed* file, so editing a tab clears its blame (see
// updateListenerFor) — the button is also disabled while a tab is dirty.
let blameCompartment: InstanceType<typeof import("@codemirror/state").Compartment> | null = null;
let gutterFn: typeof import("@codemirror/view").gutter | null = null;
let GutterMarkerCtor: typeof import("@codemirror/view").GutterMarker | null = null;
const blameEnabled = ref(false);
const blameModels = new Map<number, Map<number, BlameGutterEntry>>();

async function ensureCodeMirrorLibs() {
  if (EditorViewCtor) return;
  const [{ EditorView, gutter, GutterMarker }, { EditorState, Compartment }, cmMeta, { oneDark: theme }, { undo }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("codemirror"),
    import("@codemirror/theme-one-dark"),
    import("@codemirror/commands"),
  ]);
  EditorViewCtor = EditorView;
  EditorStateCtor = EditorState;
  basicSetup = cmMeta.basicSetup;
  oneDark = theme;
  undoCommand = undo;
  editableCompartment = new Compartment();
  blameCompartment = new Compartment();
  gutterFn = gutter;
  GutterMarkerCtor = GutterMarker;
}

// Build a CodeMirror gutter extension from a `finalLine → entry` blame model.
// One marker per source line; continuation lines of a same-commit run render
// blank (entry.showLabel === false) so the author shows once per block.
function blameGutterExtension(model: Map<number, BlameGutterEntry>): Extension {
  const GM = GutterMarkerCtor!;
  class BlameMarker extends GM {
    constructor(public entry: BlameGutterEntry) {
      super();
    }
    eq(other: BlameMarker) {
      return other.entry.hashFull === this.entry.hashFull && other.entry.showLabel === this.entry.showLabel;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "cm-blame-marker";
      span.textContent = this.entry.showLabel ? this.entry.label : "";
      span.title = this.entry.title;
      return span;
    }
  }
  return gutterFn!({
    class: "cm-blame-gutter",
    lineMarker(view, blockLine) {
      const ln = view.state.doc.lineAt(blockLine.from).number;
      const entry = model.get(ln);
      return entry ? new BlameMarker(entry) : null;
    },
    lineMarkerChange: () => false,
  });
}

// Fetch + cache the blame model for a tab. Returns false on failure or if the
// user switched tabs while the (async) blame was in flight.
async function ensureBlameForTab(tab: FileTab): Promise<boolean> {
  if (blameModels.has(tab.id)) return true;
  try {
    const lines = await getGitBlame(props.repoPath, tab.path);
    if (activeTab.value?.id !== tab.id) return false;
    blameModels.set(tab.id, buildBlameModel(lines));
    return true;
  } catch {
    return false;
  }
}

// Reconfigure the shared blame compartment on the live view for `tabId`:
// the tab's gutter when blame is on and a model is cached, empty otherwise.
function applyBlame(tabId: number) {
  if (!view || !blameCompartment) return;
  const model = blameEnabled.value ? blameModels.get(tabId) : undefined;
  view.dispatch({ effects: blameCompartment.reconfigure(model ? blameGutterExtension(model) : []) });
  docStates.set(tabId, view.state);
}

async function toggleBlame() {
  if (!activeTab.value || activeTab.value.binary) return;
  blameEnabled.value = !blameEnabled.value;
  if (blameEnabled.value) {
    const ok = await ensureBlameForTab(activeTab.value);
    if (!ok) {
      blameEnabled.value = false;
      return;
    }
  }
  if (activeTab.value) applyBlame(activeTab.value.id);
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
    // Editing shifts line numbers, so the committed blame no longer aligns:
    // drop this tab's cached model and turn blame off. Deferred to a
    // microtask to avoid dispatching a reconfigure from inside an update.
    if (blameEnabled.value) {
      blameModels.delete(tabId);
      queueMicrotask(() => {
        if (!blameEnabled.value) return;
        blameEnabled.value = false;
        applyBlame(tabId);
      });
    }
  });
}

function waitForTabLoaded(tab: FileTab): Promise<void> {
  if (!tab.loading) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(
      () => tab.loading,
      (loading) => {
        if (!loading) {
          stop();
          resolve();
        }
      },
    );
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
  if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while libs were loading

  if (tab.loading) {
    await waitForTabLoaded(tab);
    if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while we waited for content
    if (tab.binary) {
      // The read resolved to a binary file while we were waiting — re-check
      // and bail the same way the top-of-function binary guard does.
      view?.destroy();
      view = null;
      return;
    }
  }

  await nextTick();
  if (!editorHost.value) return;
  if (activeTab.value?.id !== tab.id) return; // re-check after nextTick too

  let state = docStates.get(tab.id);
  if (!state) {
    const langExt = await detectLanguageExtension(tab.path);
    if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while the grammar was loading — don't touch the shared view/docStates with a stale tab's state
    state = EditorStateCtor!.create({
      doc: tab.content,
      extensions: [
        basicSetup!,
        oneDark!,
        langExt,
        updateListenerFor(tab.id),
        editableCompartment!.of(EditorViewCtor!.editable.of(!editLocked.value)),
        blameCompartment!.of([]),
      ],
    });
    docStates.set(tab.id, state);
  }

  if (!view) {
    view = new EditorViewCtor!({ state, parent: editorHost.value });
  } else {
    view.setState(state);
  }
  // The global lock may have changed since this tab's cached state was last
  // built or visited — always re-assert it so editability is consistent
  // panel-wide, not just at the moment this tab's EditorState was created.
  applyEditable(tab.id);

  // Re-assert blame for this tab: if blame is on, load its model (once) and
  // show the gutter; otherwise applyBlame clears any gutter carried over from
  // a previously-shown state.
  if (blameEnabled.value && !tab.binary) {
    await ensureBlameForTab(tab);
    if (activeTab.value?.id !== tab.id) return;
  }
  applyBlame(tab.id);
}

// Re-assert the current lock state onto the live view and cache the result
// under `tabId`. No-op until the CodeMirror libs and a view are ready.
function applyEditable(tabId: number) {
  if (!view || !editableCompartment || !EditorViewCtor) return;
  view.dispatch({ effects: editableCompartment.reconfigure(EditorViewCtor.editable.of(!editLocked.value)) });
  docStates.set(tabId, view.state);
}

function toggleLock() {
  editLocked.value = !editLocked.value;
  if (activeTab.value) applyEditable(activeTab.value.id);
}

function onUndo() {
  if (editLocked.value || !view || !undoCommand) return;
  undoCommand(view); // dispatches internally; the existing updateListener
  // (see updateListenerFor) picks up the resulting docChanged transaction
  // and syncs it into useFileExplorer's tab.content, same as any keystroke.
}

function onToolbarSave() {
  if (!activeTab.value || activeTab.value.binary) return;
  explorer.saveTab(props.repoPath, props.repoPath, activeTab.value.id);
}

watch(activeTab, (tab) => {
  if (tab) mountTab(tab);
});

watch(
  () => tabs.value.map((t) => t.id),
  (ids, oldIds) => {
    for (const id of oldIds ?? []) {
      if (!ids.includes(id)) {
        docStates.delete(id);
        blameModels.delete(id);
      }
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
    ref="feRef"
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
    tabindex="0"
    @keydown="onKeyDown"
  >
    <div v-if="!fullscreen" class="fe__drag" :class="{ 'fe__drag--active': isDragging }" @mousedown="onDragStart" />
    <div class="fe__header" @mousedown="onMoveStart">
      <span class="fe__title">{{ t("files.headerLabel") }}</span>
      <button v-if="tree.truncated.value" class="fe__truncated" :title="t('files.truncatedTooltip')">
        {{ t("files.truncatedBadge") }}
      </button>
      <button
        class="fe__full"
        :title="fullscreen ? t('files.exitFullscreen') : t('files.fullscreen')"
        :aria-label="fullscreen ? t('files.exitFullscreen') : t('files.fullscreen')"
        @click="toggleFullscreen"
      >
        <svg v-if="!fullscreen" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
          <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
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

    <template v-if="!fullscreen && !bottom">
      <div class="fe__resize-x fe__resize-x--left" :class="{ 'fe__resize-x--active': isResizingL }" @mousedown="onResizeLeftStart" />
      <div class="fe__resize-x" :class="{ 'fe__resize-x--active': isResizingX }" @mousedown="onResizeXStart" />
      <div class="fe__resize-y fe__resize-y--bottom" :class="{ 'fe__resize-y--active': isResizingBottom }" @mousedown="onResizeBottomStart" />
      <div class="fe__corner fe__corner--tl" :class="{ 'fe__corner--active': resizingCorner === 'tl' }" @mousedown="onResizeCornerStart('tl', $event)" />
      <div class="fe__corner fe__corner--tr" :class="{ 'fe__corner--active': resizingCorner === 'tr' }" @mousedown="onResizeCornerStart('tr', $event)" />
      <div class="fe__corner fe__corner--bl" :class="{ 'fe__corner--active': resizingCorner === 'bl' }" @mousedown="onResizeCornerStart('bl', $event)" />
      <div class="fe__corner fe__corner--br" :class="{ 'fe__corner--active': resizingCorner === 'br' }" @mousedown="onResizeCornerStart('br', $event)" />
    </template>

    <div class="fe__toolbar">
      <button
        class="fe__toolbar-btn"
        :class="{ 'fe__toolbar-btn--active': !editLocked }"
        :title="editLocked ? t('files.toolbarEdit') : t('files.toolbarLock')"
        @click="toggleLock"
      >
        <svg v-if="editLocked" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2"/>
          <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2"/>
          <path d="M8 11V7a4 4 0 0 1 7.75-1.5"/>
        </svg>
        <span>{{ editLocked ? t("files.toolbarEdit") : t("files.toolbarLock") }}</span>
      </button>
      <button class="fe__toolbar-btn" :disabled="editLocked" :title="t('files.toolbarUndo')" @click="onUndo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7v6h6"/>
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
        </svg>
        <span>{{ t("files.toolbarUndo") }}</span>
      </button>
      <button
        class="fe__toolbar-btn"
        :class="{ 'fe__toolbar-btn--active': blameEnabled }"
        :disabled="!activeTab || activeTab.binary || explorer.isDirty(activeTab)"
        :title="t('files.toolbarBlame')"
        @click="toggleBlame"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/>
          <line x1="1.5" y1="12" x2="8" y2="12"/>
          <line x1="16" y1="12" x2="22.5" y2="12"/>
        </svg>
        <span>{{ t("files.toolbarBlame") }}</span>
      </button>
      <div class="fe__toolbar-spacer" />
      <button
        class="fe__toolbar-btn"
        :disabled="!activeTab || activeTab.binary || !explorer.isDirty(activeTab)"
        :title="t('files.toolbarSave')"
        @click="onToolbarSave"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
          <polyline points="7 3 7 8 15 8"/>
        </svg>
        <span>{{ t("files.toolbarSave") }}</span>
      </button>
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

.fe__drag {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 5px;
  cursor: ns-resize;
  z-index: 3;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

.fe__resize-x {
  position: absolute;
  top: 0;
  right: -4px;
  width: 8px;
  height: 100%;
  cursor: ew-resize;
  z-index: 1;
}

.fe__resize-x--left {
  right: auto;
  left: -4px;
}

.fe__resize-y {
  position: absolute;
  left: 0;
  width: 100%;
  height: 8px;
  cursor: ns-resize;
  z-index: 1;
}

.fe__resize-y--bottom {
  bottom: -4px;
}

.fe__corner {
  position: absolute;
  width: 14px;
  height: 14px;
  z-index: 2;
}

.fe__corner--tl {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}

.fe__corner--tr {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}

.fe__corner--bl {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}

.fe__corner--br {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}

.fe__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  cursor: grab;
}

.fe__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  flex: 1;
}

.fe__close {
  font-size: var(--font-size-xl);
  color: var(--color-text-muted);
}

.fe__full {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: var(--space-2);
  color: var(--color-text-muted);
}

.fe__full:hover,
.fe__close:hover {
  color: var(--color-text);
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

/* Blame gutter (opt-in) — sits alongside the line-number gutter, showing
   `author · date` once per same-commit run. Full details on hover (title).
   The editor is always the oneDark theme regardless of the app light/dark
   theme, so these colours are hard-coded to oneDark's own gutter palette
   (background #282c34, stone #7d8799, darkBackground #21252b) rather than the
   app `--color-*` tokens — those rendered a light gutter on the dark editor in
   light mode. */
.fe__content :deep(.cm-blame-gutter) {
  background-color: #282c34;
  border-right: 1px solid #21252b;
  color: #7d8799;
  font-size: 11px;
}
.fe__content :deep(.cm-blame-marker) {
  display: inline-block;
  overflow: hidden;
  max-width: 190px;
  padding: 0 var(--space-2);
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: default;
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

.fe__toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe__toolbar-spacer {
  flex: 1;
}

.fe__toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  background: var(--color-bg-tertiary);
}

.fe__toolbar-btn:hover:not(:disabled) {
  color: var(--color-text);
}

.fe__toolbar-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.fe__toolbar-btn--active {
  color: var(--color-accent);
}
</style>
