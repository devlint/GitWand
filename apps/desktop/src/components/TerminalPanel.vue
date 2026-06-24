<script setup lang="ts">
import { ref, onBeforeUnmount, watch, nextTick, computed } from "vue";
import { useTerminalSessions, type TerminalTab } from "../composables/useTerminalSessions";
import { useI18n } from "../composables/useI18n";
import { useSettings } from "../composables/useSettings";

const props = defineProps<{ repoPath: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "new"): void;
  (e: "new-agent", tool: string): void;
  (e: "open-sessions"): void;
}>();
const { t } = useI18n();
const { settings } = useSettings();

const sessions = useTerminalSessions();
const tabs = computed(() => sessions.tabsFor(props.repoPath));
const activeId = computed(() => sessions.activeTabId(props.repoPath));

// ─── "+" dropdown ────────────────────────────────────────
const showDropdown = ref(false);

function onDocumentClickClose() {
  showDropdown.value = false;
}

function openDropdown(e: MouseEvent) {
  e.stopPropagation();
  if (showDropdown.value) {
    showDropdown.value = false;
    document.removeEventListener("click", onDocumentClickClose);
  } else {
    showDropdown.value = true;
    document.addEventListener("click", onDocumentClickClose);
  }
}

function selectDropdownItem(action: () => void) {
  showDropdown.value = false;
  document.removeEventListener("click", onDocumentClickClose);
  action();
}

// xterm instances kept OUTSIDE Vue reactivity — plain Map only.
type XtermEntry = { term: any; fit: any; ro: ResizeObserver; sessionId: number };
const xterms = new Map<number, XtermEntry>(); // key = tab.id (local)
let XtermCtor: any = null;
let FitCtor: any = null;

// Pending buffer for output chunks that arrive before the xterm is mounted.
// Keyed by tab.id (same key space as xterms). Not reactive — plain Map.
const pendingChunks = new Map<number, string[]>();

const hostRefs = ref<Record<number, HTMLElement | undefined>>({});

// Panel height — persisted.
const HEIGHT_KEY = "gitwand-terminal-height";
const height = ref(Number(localStorage.getItem(HEIGHT_KEY)) || 260);

async function ensureXtermLibs() {
  if (XtermCtor) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  XtermCtor = Terminal;
  FitCtor = FitAddon;
  // CSS loaded once — dynamic import deduplicated by Vite.
  await import("@xterm/xterm/css/xterm.css");
}

async function mountTab(tab: TerminalTab) {
  await ensureXtermLibs();
  await nextTick();
  const el = hostRefs.value[tab.id];
  if (!el || xterms.has(tab.id)) return;

  const term = new XtermCtor({ fontSize: settings.value.terminalFontSize ?? 13, cursorBlink: true });
  const fit = new FitCtor();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();

  term.onData((data: string) => sessions.write(tab.sessionId, data));
  term.onTitleChange((title: string) =>
    sessions.setTitleFromShell(props.repoPath, tab.id, title),
  );

  const ro = new ResizeObserver(() => {
    fit.fit();
    sessions.resize(tab.sessionId, term.cols, term.rows);
  });
  ro.observe(el);

  xterms.set(tab.id, { term, fit, ro, sessionId: tab.sessionId });

  // Flush any output that arrived before the xterm was mounted.
  const buffered = pendingChunks.get(tab.id);
  if (buffered) {
    for (const chunk of buffered) term.write(chunk);
    pendingChunks.delete(tab.id);
  }
}

// Exposed so App.vue can route PTY chunks to the correct xterm instance.
// Routes by stable tab.id (the Map key). If the xterm is not yet mounted,
// buffers the chunk so it is flushed when mountTab completes.
function writeChunk(tabId: number, chunk: string) {
  const entry = xterms.get(tabId);
  if (entry) {
    entry.term.write(chunk);
  } else {
    // xterm not yet mounted — buffer until mountTab flushes.
    let buf = pendingChunks.get(tabId);
    if (!buf) { buf = []; pendingChunks.set(tabId, buf); }
    buf.push(chunk);
  }
}
defineExpose({ writeChunk });

watch(
  () => tabs.value.map((t) => `${t.id}:${t.sessionId}`).join("|"),
  async () => {
    // Mount new tabs and refresh sessionId on existing ones.
    for (const tab of tabs.value) {
      await mountTab(tab);
      const entry = xterms.get(tab.id);
      if (entry && entry.sessionId !== tab.sessionId && tab.sessionId >= 0) {
        entry.sessionId = tab.sessionId;
      }
    }
    // Dispose xterms for closed tabs.
    for (const id of [...xterms.keys()]) {
      if (!tabs.value.some((t) => t.id === id)) {
        const entry = xterms.get(id);
        entry?.ro.disconnect();
        entry?.term.dispose();
        xterms.delete(id);
        pendingChunks.delete(id);
      }
    }
    // Purge buffered chunks for tabs that closed before their xterm mounted.
    for (const id of pendingChunks.keys()) {
      if (!tabs.value.some((t) => t.id === id)) pendingChunks.delete(id);
    }
  },
  { immediate: true },
);

function onFocusIn() {
  sessions.terminalFocused.value = true;
}
function onFocusOut() {
  sessions.terminalFocused.value = false;
}

// Inline rename.
const editingId = ref<number | null>(null);
const editValue = ref("");
function startRename(tab: TerminalTab) {
  editingId.value = tab.id;
  editValue.value = tab.title;
}
function commitRename(tab: TerminalTab) {
  if (editValue.value.trim()) {
    sessions.renameTab(props.repoPath, tab.id, editValue.value.trim());
  }
  editingId.value = null;
}

// Drag-to-resize.
let dragStartY = 0;
let dragStartH = 0;
function onDragStart(e: MouseEvent) {
  dragStartY = e.clientY;
  dragStartH = height.value;
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}
function onDragMove(e: MouseEvent) {
  height.value = Math.max(120, Math.min(700, dragStartH + (dragStartY - e.clientY)));
}
function onDragEnd() {
  localStorage.setItem(HEIGHT_KEY, String(height.value));
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
}

onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
  for (const [, entry] of xterms) {
    entry.ro.disconnect();
    entry.term.dispose();
  }
  xterms.clear();
  document.removeEventListener("click", onDocumentClickClose);
});
</script>

<template>
  <div
    class="tp"
    :style="{ height: height + 'px' }"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <!-- Drag handle — drag upward to grow the panel -->
    <div class="tp__drag" @mousedown="onDragStart" />

    <!-- Tab bar -->
    <div class="tp__tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tp__tab"
        :class="{ 'tp__tab--active': tab.id === activeId }"
        @click="sessions.setActive(props.repoPath, tab.id)"
        @dblclick="startRename(tab)"
      >
        <input
          v-if="editingId === tab.id"
          v-model="editValue"
          class="tp__rename"
          @keyup.enter="commitRename(tab)"
          @blur="commitRename(tab)"
        />
        <span v-else>{{ tab.title }}</span>
        <span
          class="tp__close"
          role="button"
          :aria-label="t('terminal.closeTab')"
          @click.stop="sessions.closeTab(props.repoPath, tab.id)"
        >×</span>
      </button>

      <div class="tp__new-wrap">
        <button class="tp__new" :title="t('terminal.newTab')" @click="openDropdown">+</button>
        <div v-if="showDropdown" class="tp__menu" @click.stop>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('new'))">
            {{ t('terminal.menuShell') }}
          </button>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('new-agent', 'claude'))">
            {{ t('terminal.menuClaude') }}
          </button>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('new-agent', 'codex'))">
            {{ t('terminal.menuCodex') }}
          </button>
          <button class="tp__menu-item" @click="selectDropdownItem(() => emit('open-sessions'))">
            {{ t('terminal.menuSessions') }}
          </button>
        </div>
      </div>
      <button class="tp__hide" :title="t('terminal.hide')" @click="emit('close')">⌄</button>
    </div>

    <!-- xterm host elements — one per tab, visibility toggled via v-show -->
    <div class="tp__body">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tp__host"
        :ref="(el) => { if (el) hostRefs[tab.id] = el as HTMLElement; }"
        v-show="tab.id === activeId"
      />
    </div>
  </div>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border, var(--color-border));
  background: var(--bg-elevated, var(--color-bg-secondary));
  flex-shrink: 0;
}

.tp__drag {
  height: 5px;
  cursor: ns-resize;
  flex-shrink: 0;
}

.tp__tabs {
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 0 6px;
  flex-shrink: 0;
}

.tp__tab {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  font-size: var(--font-size-xs);
}

.tp__tab--active {
  background: var(--bg-base, var(--color-bg));
}

.tp__close {
  opacity: 0.6;
  line-height: 1;
}

.tp__close:hover {
  opacity: 1;
}

.tp__new {
  margin-left: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-xs);
}

.tp__hide {
  margin-left: auto;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-xs);
}

.tp__new:hover,
.tp__hide:hover,
.tp__tab:hover {
  background: var(--color-bg-hover);
}

.tp__body {
  flex: 1;
  position: relative;
  overflow: hidden;
  min-height: 0;
}

.tp__host {
  position: absolute;
  inset: 0;
}

.tp__rename {
  width: 90px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: inherit;
  padding: 0 4px;
}

.tp__new-wrap {
  position: relative;
}

.tp__menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--bg-elevated, var(--color-bg-secondary));
  border: 1px solid var(--border, var(--color-border));
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  min-width: 140px;
  padding: 2px 0;
}

.tp__menu-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text, var(--color-text));
  white-space: nowrap;
}

.tp__menu-item:hover {
  background: var(--hover, var(--color-hover));
}
</style>
