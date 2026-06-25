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
  (e: "new-ai-task"): void;
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
type XtermEntry = {
  term: any;
  fit: any;
  search: any;       // SearchAddon — used by the search bar
  ro: ResizeObserver;
  sessionId: number;
};
const xterms = new Map<number, XtermEntry>(); // key = tab.id (local)
let XtermCtor: any = null;
let FitCtor: any = null;
let WebglCtor: any = null;
let SearchCtor: any = null;
let WebLinksCtor: any = null;

// Pending buffer for output chunks that arrive before the xterm is mounted.
// Keyed by tab.id (same key space as xterms). Not reactive — plain Map.
const pendingChunks = new Map<number, string[]>();

// Fix 6 — Keystroke input buffer for keystrokes typed before the PTY is ready
// (i.e. while tab.sessionId is still -1). Flushed to the PTY once sessionId
// transitions from -1 to a positive value. Keyed by tab.id. Not reactive.
const pendingInput = new Map<number, string[]>();

const hostRefs = ref<Record<number, HTMLElement | undefined>>({});

// Panel height — persisted.
const HEIGHT_KEY = "gitwand-terminal-height";
const height = ref(Number(localStorage.getItem(HEIGHT_KEY)) || 260);

async function ensureXtermLibs() {
  if (XtermCtor) return;
  const [
    { Terminal },
    { FitAddon },
    { WebglAddon },
    { SearchAddon },
    { WebLinksAddon },
  ] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-webgl"),
    import("@xterm/addon-search"),
    import("@xterm/addon-web-links"),
  ]);
  XtermCtor = Terminal;
  FitCtor = FitAddon;
  WebglCtor = WebglAddon;
  SearchCtor = SearchAddon;
  WebLinksCtor = WebLinksAddon;
  await import("@xterm/xterm/css/xterm.css");
}

async function mountTab(tab: TerminalTab) {
  await ensureXtermLibs();
  await nextTick();
  const el = hostRefs.value[tab.id];
  if (!el || xterms.has(tab.id)) return;

  const term = new XtermCtor({ fontSize: settings.value.terminalFontSize ?? 13, cursorBlink: true });
  const fit = new FitCtor();
  const search = new SearchCtor();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksCtor());
  term.open(el);

  // WebGL2 renderer — GPU-accelerated rendering like Terax.
  // Falls back silently to the built-in canvas renderer if WebGL2 is unavailable.
  const webgl = new WebglCtor();
  try {
    term.loadAddon(webgl);
  } catch {
    webgl.dispose();
  }

  fit.fit();

  // Fix 6 — Buffer keystrokes when the PTY is not yet ready (sessionId is -1).
  // Keystrokes typed while awaiting terminalOpen would otherwise call
  // terminalWrite(-1) which returns "session not found" and silently drops input.
  term.onData((data: string) => {
    if (tab.sessionId >= 0) {
      sessions.write(tab.sessionId, data);
    } else {
      // PTY not ready yet — buffer until sessionId is assigned.
      let buf = pendingInput.get(tab.id);
      if (!buf) { buf = []; pendingInput.set(tab.id, buf); }
      buf.push(data);
    }
  });
  term.onTitleChange((title: string) =>
    sessions.setTitleFromShell(props.repoPath, tab.id, title),
  );

  const ro = new ResizeObserver(() => {
    fit.fit();
    sessions.resize(tab.sessionId, term.cols, term.rows);
  });
  ro.observe(el);

  xterms.set(tab.id, { term, fit, search, ro, sessionId: tab.sessionId });

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
        // Fix 6 — PTY is now ready: flush any keystrokes buffered while
        // sessionId was -1 (typed before terminalOpen resolved).
        const queued = pendingInput.get(tab.id);
        if (queued?.length) {
          queued.forEach(d => sessions.write(tab.sessionId, d));
          pendingInput.delete(tab.id);
        }
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
        pendingInput.delete(id); // Fix 6 — purge input buffer for closed tabs
      }
    }
    // Purge buffered chunks for tabs that closed before their xterm mounted.
    for (const id of pendingChunks.keys()) {
      if (!tabs.value.some((t) => t.id === id)) pendingChunks.delete(id);
    }
    // Fix 6 — Purge input buffer for tabs that closed before their PTY was ready.
    for (const id of pendingInput.keys()) {
      if (!tabs.value.some((t) => t.id === id)) pendingInput.delete(id);
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

// Inline search bar state — one shared bar, operates on the active tab's SearchAddon.
const searchVisible = ref(false);
const searchQuery = ref("");
const searchHasResult = ref(true);

function openSearch() {
  searchVisible.value = true;
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(".tp__search-input");
    input?.focus();
  });
}

function closeSearch() {
  searchVisible.value = false;
  searchQuery.value = "";
}

function doSearch(direction: "next" | "prev") {
  const active = tabs.value.find(t => t.id === activeId.value);
  if (!active) return;
  const entry = xterms.get(active.id);
  if (!entry?.search || !searchQuery.value) return;
  const found =
    direction === "next"
      ? entry.search.findNext(searchQuery.value, { regex: false, caseSensitive: false })
      : entry.search.findPrevious(searchQuery.value, { regex: false, caseSensitive: false });
  searchHasResult.value = found !== false;
}

function onKeyDown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    openSearch();
  }
  if (e.key === "Escape" && searchVisible.value) {
    closeSearch();
  }
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
const isDragging = ref(false);
function onDragStart(e: MouseEvent) {
  e.preventDefault();
  dragStartY = e.clientY;
  dragStartH = height.value;
  isDragging.value = true;
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onDragMove, { passive: false });
  window.addEventListener("mouseup", onDragEnd);
}
function onDragMove(e: MouseEvent) {
  e.preventDefault();
  height.value = Math.max(120, Math.min(700, dragStartH + (dragStartY - e.clientY)));
}
function onDragEnd() {
  localStorage.setItem(HEIGHT_KEY, String(height.value));
  isDragging.value = false;
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
}

onBeforeUnmount(() => {
  document.body.style.userSelect = "";
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
    @keydown="onKeyDown"
  >
    <!-- Drag handle — drag upward to grow the panel -->
    <div class="tp__drag" :class="{ 'tp__drag--active': isDragging }" @mousedown="onDragStart" />

    <!-- Tab bar -->
    <div class="tp__tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tp__tab"
        :class="{ 'tp__tab--active': tab.id === activeId }"
        @click="() => { sessions.setActive(props.repoPath, tab.id); sessions.markRead(props.repoPath, tab.id); }"
        @dblclick="startRename(tab)"
      >
        <input
          v-if="editingId === tab.id"
          v-model="editValue"
          class="tp__rename"
          @keyup.enter="commitRename(tab)"
          @blur="commitRename(tab)"
        />
        <span v-else class="tp__tab-label">
          <span class="tp__tab-icon" :class="`tp__tab-icon--${tab.type}`">
            {{ tab.type === 'claude' ? 'C' : tab.type === 'codex' ? '⚡' : '$' }}
          </span>
          {{ tab.title }}
          <span v-if="tab.hasUnread && tab.id !== activeId" class="tp__unread" />
        </span>
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
          <button class="tp__menu-item tp__menu-item--accent" @click="selectDropdownItem(() => emit('new-ai-task'))">
            {{ t('terminal.menuNewAiTask') }}
          </button>
        </div>
      </div>
      <button class="tp__hide" :title="t('terminal.hide')" @click="emit('close')">⌄</button>
    </div>

    <!-- xterm host elements — one per tab, visibility toggled via v-show -->
    <div class="tp__body">
      <!-- Search bar — shown when searchVisible is true -->
      <div v-if="searchVisible" class="tp__search">
        <input
          class="tp__search-input"
          :placeholder="t('terminal.searchPlaceholder')"
          v-model="searchQuery"
          @input="doSearch('next')"
          @keyup.enter="doSearch('next')"
          @keyup.shift.enter="doSearch('prev')"
        />
        <button class="tp__search-btn" @click="doSearch('prev')" title="Previous (Shift+Enter)">↑</button>
        <button class="tp__search-btn" @click="doSearch('next')" title="Next (Enter)">↓</button>
        <span v-if="!searchHasResult" class="tp__search-noresult">{{ t('terminal.searchNoResult') }}</span>
        <button class="tp__search-close" @click="closeSearch">×</button>
      </div>
      <div class="tp__hosts">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="tp__host"
          :ref="(el) => { if (el) hostRefs[tab.id] = el as HTMLElement; }"
          v-show="tab.id === activeId"
        />
      </div>
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
  transition: background 0.15s;
}

.tp__drag:hover,
.tp__drag--active {
  background: var(--color-accent);
}

.tp__tabs {
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 4px 6px;
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
  font-size: var(--font-size-sm);
}

.tp__tab--active {
  background: var(--bg-base, var(--color-bg));
}

.tp__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  opacity: 0.5;
  flex-shrink: 0;
}

.tp__close:hover {
  opacity: 1;
  background: var(--color-bg-hover);
}

.tp__new {
  margin-left: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-sm);
}

.tp__hide {
  margin-left: auto;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-sm);
}

.tp__new:hover,
.tp__hide:hover,
.tp__tab:hover {
  background: var(--color-bg-hover);
}

.tp__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tp__hosts {
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
  left: 0;
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
  font-size: 14px;
  color: var(--text, var(--color-text));
  white-space: nowrap;
}

.tp__menu-item:hover {
  background: var(--hover, var(--color-hover));
}

.tp__menu-item--accent {
  color: var(--color-accent);
  font-weight: 500;
  border-top: 1px solid var(--color-border);
  margin-top: 2px;
  padding-top: 8px;
}

.tp__search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border, var(--color-border));
  flex-shrink: 0;
  background: var(--bg-elevated, var(--color-bg-secondary));
}

.tp__search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--bg-base, var(--color-bg));
  color: inherit;
  font-size: var(--font-size-sm);
  padding: 2px 6px;
}

.tp__search-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-sm);
}

.tp__search-btn:hover {
  background: var(--color-bg-hover);
}

.tp__search-noresult {
  font-size: var(--font-size-xs, 11px);
  color: var(--color-danger, #e05c5c);
}

.tp__search-close {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: 14px;
  opacity: 0.5;
}

.tp__search-close:hover {
  opacity: 1;
  background: var(--color-bg-hover);
}

.tp__tab-label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tp__tab-icon {
  font-size: 10px;
  opacity: 0.6;
  font-family: monospace;
  min-width: 12px;
}

.tp__tab-icon--claude {
  color: var(--color-accent);
  opacity: 1;
  font-weight: bold;
}

.tp__tab-icon--codex {
  color: #a370f7;
  opacity: 1;
}

.tp__unread {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}
</style>
