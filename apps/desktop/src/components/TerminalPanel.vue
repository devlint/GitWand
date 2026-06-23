<script setup lang="ts">
import { ref, onBeforeUnmount, watch, nextTick, computed } from "vue";
import { useTerminalSessions, type TerminalTab } from "../composables/useTerminalSessions";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{ repoPath: string }>();
const emit = defineEmits<{ (e: "close"): void; (e: "new"): void }>();
const { t } = useI18n();

const sessions = useTerminalSessions();
const tabs = computed(() => sessions.tabsFor(props.repoPath));
const activeId = computed(() => sessions.activeTabId(props.repoPath));

// xterm instances kept OUTSIDE Vue reactivity — plain Map only.
type XtermEntry = { term: any; fit: any; ro: ResizeObserver; sessionId: number };
const xterms = new Map<number, XtermEntry>(); // key = tab.id (local)
let XtermCtor: any = null;
let FitCtor: any = null;

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

  const term = new XtermCtor({ fontSize: 13, cursorBlink: true });
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
}

// Exposed so App.vue can route PTY chunks to the correct xterm instance.
function writeChunk(sessionId: number, chunk: string) {
  for (const [, entry] of xterms) {
    if (entry.sessionId === sessionId) {
      entry.term.write(chunk);
      return;
    }
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
      }
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

      <button class="tp__new" :title="t('terminal.newTab')" @click="emit('new')">+</button>
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
</style>
