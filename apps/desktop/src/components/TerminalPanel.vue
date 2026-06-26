<script setup lang="ts">
import { ref, onBeforeUnmount, watch, nextTick, computed, onMounted, onActivated } from "vue";
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
const { settings, saveSettings } = useSettings();

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

// Panel size + position — persisted.
const HEIGHT_KEY = "gitwand-terminal-height";
const LEFT_KEY   = "gitwand-terminal-left";
const WIDTH_KEY  = "gitwand-terminal-width";
const TOP_KEY    = "gitwand-terminal-top";
const height = ref(Number(localStorage.getItem(HEIGHT_KEY)) || 260);
const left   = ref(Number(localStorage.getItem(LEFT_KEY))   || 16);
const width  = ref(Number(localStorage.getItem(WIDTH_KEY))  || 0); // 0 = not yet set; initialised on mount
const top    = ref(Number(localStorage.getItem(TOP_KEY))    || 0); // 0 = not yet set; initialised on mount

const tpRef = ref<HTMLElement | null>(null);

// Layout mode is driven by settings (set from the dock context menu).
//  - "fullscreen" fills the app-body area (project list / header stay visible).
//  - "bottom" is a full-width strip that pushes the content up.
//  - "floating" is the resizable/movable overlay (default).
const mode = computed(() => settings.value.terminalMode);
const fullscreen = computed(() => mode.value === "fullscreen");
const bottom = computed(() => mode.value === "bottom");
// The inline header button toggles fullscreen on/off, restoring the layout that
// was active before fullscreen (floating or bottom) on the way out.
function toggleFullscreen() {
  if (fullscreen.value) {
    settings.value.terminalMode = settings.value.terminalPrevMode;
  } else {
    settings.value.terminalPrevMode = mode.value as "floating" | "bottom";
    settings.value.terminalMode = "fullscreen";
  }
  saveSettings(settings.value);
}

onMounted(() => {
  const parent = tpRef.value?.parentElement;
  if (!width.value) {
    width.value = Math.round((parent?.offsetWidth ?? window.innerWidth) * 0.5);
  }
  if (!top.value) {
    // First open: sit near the bottom, like the old bottom-anchored default.
    const ph = parent?.offsetHeight ?? window.innerHeight;
    top.value = Math.max(8, ph - height.value - 16);
  }
});

const panelStyle = computed(() => {
  if (fullscreen.value) return { inset: "0", height: "auto", left: "0", width: "100%" };
  // Bottom mode: in-flow docked aside (position handled by .tp--bottom) so it
  // reserves layout space and pushes content up. Only the height is dynamic.
  if (bottom.value) return { height: height.value + "px" };
  // Floating: free-positioned overlay — top + left so it floats anywhere, not
  // pinned to the bottom edge. `bottom: auto` clears the base anchor.
  return {
    top:    top.value    + "px",
    bottom: "auto",
    height: height.value + "px",
    left:   left.value   + "px",
    width:  width.value  ? width.value + "px" : "50%",
  };
});

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

// Tabs whose PTY has already received the post-boot resize kick (see below).
const kicked = new Set<number>();

// Force the child to redraw at the real terminal size.
//
// On spawn the PTY is 80×24 (terminalOpen placeholder). A plain same-size
// resize emits no SIGWINCH, and an early fit() can measure 80×24 before the
// host element is laid out — so syncPtySize alone isn't enough for a TUI like
// claude that latches its size at boot. We trigger this once the child has
// produced its first output (it has booted and the host is laid out by then):
// re-fit, then jiggle the rows by 1 so the kernel always emits a SIGWINCH the
// child cannot miss, then snap back to the real size.
//
// The off-size must be HELD with a real timeout gap (not a rAF). On re-show the
// panel size usually equals the pre-hide size, so the two resizes are the only
// SIGWINCH the child gets. With a rAF the kernel coalesces shrink+restore into a
// net-zero change within one frame and the child (claude) ignores it — the
// terminal stays blank until a manual resize. A held delay guarantees two
// distinct SIGWINCH the child must act on.
function kickResize(tab: TerminalTab) {
  const entry = xterms.get(tab.id);
  if (!entry || tab.sessionId < 0) return;
  entry.fit.fit();
  const { cols, rows } = entry.term;
  if (!cols || !rows) return;
  sessions.resize(tab.sessionId, cols, Math.max(1, rows - 1));
  setTimeout(() => {
    if (tab.sessionId >= 0) sessions.resize(tab.sessionId, cols, rows);
  }, 200);
}

// Retry a fit until the host element actually has a size, then sync the PTY and
// kick a running child to redraw. Bounded retry — layout settles at an
// unpredictable frame after a remount (v-if toggle, async component, fonts), so
// a single rAF is unreliable. Stops as soon as one fit lands on a sized host.
function refitWhenSized(tabId: number, el: HTMLElement, attempt = 0) {
  const entry = xterms.get(tabId);
  if (!entry) return; // tab closed mid-retry
  if (el.offsetWidth === 0 || el.offsetHeight === 0) {
    if (attempt < 20) setTimeout(() => refitWhenSized(tabId, el, attempt + 1), 100);
    return;
  }
  entry.fit.fit();
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab && tab.sessionId >= 0) {
    sessions.resize(tab.sessionId, entry.term.cols, entry.term.rows);
    kickResize(tab);
  }
}

// Guards against concurrent mountTab() invocations for the same tab. Two watch
// runs can overlap (the first awaits the dynamic xterm import) and would
// otherwise both pass the `xterms.has` check and mount two terminals.
const mounting = new Set<number>();

async function mountTab(tab: TerminalTab) {
  if (xterms.has(tab.id) || mounting.has(tab.id)) return;
  mounting.add(tab.id);
  try {
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

  // The fit() above can measure 0×0 when the host is not laid out yet — this
  // happens on every remount (the panel uses v-if, so toggling it off then on
  // re-runs mountTab). A new tab is rescued by the output-driven kickResize in
  // writeChunk, but an already-running session emits no new output on re-show,
  // so without an explicit refit the terminal stays blank until a manual resize
  // fires the ResizeObserver. Layout settles at an unpredictable moment (async
  // component, backdrop-filter, font load) so a single rAF is flaky — retry
  // until the host has a real size, then refit and kick the PTY so a running
  // child (TUI) redraws.
  refitWhenSized(tab.id, el);
  } finally {
    mounting.delete(tab.id);
  }
}

// Exposed so App.vue can route PTY chunks to the correct xterm instance.
// Routes by stable tab.id (the Map key). If the xterm is not yet mounted,
// buffers the chunk so it is flushed when mountTab completes.
function writeChunk(tabId: number, chunk: string) {
  const entry = xterms.get(tabId);
  if (entry) {
    entry.term.write(chunk);
    // First output from the child → it has booted and the host is laid out.
    // Kick the PTY size now so a TUI that latched 80×24 at boot snaps to full.
    if (!kicked.has(tabId)) {
      kicked.add(tabId);
      const tab = tabs.value.find((t) => t.id === tabId);
      if (tab) kickResize(tab);
    }
  } else {
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
        kicked.delete(id);
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

// KeepAlive: the panel is deactivated (not unmounted) when hidden, so xterm
// instances and their buffers survive a hide/show cycle. On re-show the host
// elements are re-attached at a possibly different size and the WebGL renderer
// needs a repaint, so refit every mounted tab once its host is sized again.
onActivated(() => {
  for (const id of xterms.keys()) {
    const el = hostRefs.value[id];
    if (el) refitWhenSized(id, el);
  }
});

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

// Drag-to-resize (top edge) — grows upward, keeping the bottom edge fixed.
let dragStartY   = 0;
let dragStartH   = 0;
let dragStartTop = 0;
const isDragging = ref(false);
function onDragStart(e: MouseEvent) {
  e.preventDefault();
  dragStartY   = e.clientY;
  dragStartH   = height.value;
  dragStartTop = top.value;
  isDragging.value = true;
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onDragMove, { passive: false });
  window.addEventListener("mouseup", onDragEnd);
}
function onDragMove(e: MouseEvent) {
  e.preventDefault();
  height.value = Math.max(120, dragStartH + (dragStartY - e.clientY));
  // Move the top up by the height gained so the bottom edge stays put (floating).
  top.value = Math.max(0, dragStartTop - (height.value - dragStartH));
}
function onDragEnd() {
  localStorage.setItem(HEIGHT_KEY, String(height.value));
  localStorage.setItem(TOP_KEY,    String(top.value));
  isDragging.value = false;
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
}

// Drag-to-move (tab bar) — both axes so the floating panel moves freely.
let moveStartX    = 0;
let moveStartY    = 0;
let moveStartLeft = 0;
let moveStartTop  = 0;
let isMoving      = false;
function onMoveStart(e: MouseEvent) {
  // Bottom mode is docked full-width — the panel can't be moved.
  if (bottom.value) return;
  if ((e.target as HTMLElement).closest("button, .tp__tab, .tp__rename, .tp__menu")) return;
  e.preventDefault();
  moveStartX    = e.clientX;
  moveStartY    = e.clientY;
  moveStartLeft = left.value;
  moveStartTop  = top.value;
  isMoving      = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor     = "grabbing";
  window.addEventListener("mousemove", onMoveMove, { passive: false });
  window.addEventListener("mouseup",   onMoveEnd);
}
function onMoveMove(e: MouseEvent) {
  if (!isMoving) return;
  e.preventDefault();
  const containerW = tpRef.value?.parentElement?.offsetWidth ?? window.innerWidth;
  const containerH = tpRef.value?.parentElement?.offsetHeight ?? window.innerHeight;
  const panelW     = tpRef.value?.offsetWidth  ?? width.value;
  const panelH     = tpRef.value?.offsetHeight ?? height.value;
  left.value = Math.max(0, Math.min(containerW - panelW, moveStartLeft + (e.clientX - moveStartX)));
  top.value  = Math.max(0, Math.min(containerH - panelH, moveStartTop  + (e.clientY - moveStartY)));
}
function onMoveEnd() {
  localStorage.setItem(LEFT_KEY, String(left.value));
  localStorage.setItem(TOP_KEY,  String(top.value));
  isMoving                    = false;
  document.body.style.userSelect = "";
  document.body.style.cursor     = "";
  window.removeEventListener("mousemove", onMoveMove);
  window.removeEventListener("mouseup",   onMoveEnd);
}

// Drag-to-resize-width (right edge handle).
let resizeXStartX = 0;
let resizeXStartW = 0;
const isResizingX = ref(false);
function onResizeXStart(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  resizeXStartX = e.clientX;
  resizeXStartW = tpRef.value?.offsetWidth ?? width.value;
  isResizingX.value = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor     = "ew-resize";
  window.addEventListener("mousemove", onResizeXMove, { passive: false });
  window.addEventListener("mouseup",   onResizeXEnd);
}
function onResizeXMove(e: MouseEvent) {
  if (!isResizingX.value) return;
  e.preventDefault();
  const containerW = tpRef.value?.parentElement?.offsetWidth ?? window.innerWidth;
  const newW = resizeXStartW + (e.clientX - resizeXStartX);
  width.value = Math.max(300, Math.min(containerW - left.value, newW));
}
function onResizeXEnd() {
  localStorage.setItem(WIDTH_KEY, String(width.value));
  isResizingX.value = false;
  document.body.style.userSelect = "";
  document.body.style.cursor     = "";
  window.removeEventListener("mousemove", onResizeXMove);
  window.removeEventListener("mouseup",   onResizeXEnd);
}

// Drag-to-resize-width (left edge handle) — moves the left edge, keeping the
// right edge fixed: grows width as it drags left, shrinks as it drags right.
let resizeLStartX = 0;
let resizeLStartW = 0;
let resizeLStartLeft = 0;
const isResizingL = ref(false);
function onResizeLeftStart(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  resizeLStartX = e.clientX;
  resizeLStartW = tpRef.value?.offsetWidth ?? width.value;
  resizeLStartLeft = left.value;
  isResizingL.value = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor     = "ew-resize";
  window.addEventListener("mousemove", onResizeLeftMove, { passive: false });
  window.addEventListener("mouseup",   onResizeLeftEnd);
}
function onResizeLeftMove(e: MouseEvent) {
  if (!isResizingL.value) return;
  e.preventDefault();
  const delta = e.clientX - resizeLStartX;
  const rightEdge = resizeLStartLeft + resizeLStartW; // fixed
  // Clamp left so width stays >= 300 and the panel never leaves the container.
  const newLeft = Math.max(0, Math.min(rightEdge - 300, resizeLStartLeft + delta));
  left.value  = newLeft;
  width.value = rightEdge - newLeft;
}
function onResizeLeftEnd() {
  localStorage.setItem(WIDTH_KEY, String(width.value));
  localStorage.setItem(LEFT_KEY,  String(left.value));
  isResizingL.value = false;
  document.body.style.userSelect = "";
  document.body.style.cursor     = "";
  window.removeEventListener("mousemove", onResizeLeftMove);
  window.removeEventListener("mouseup",   onResizeLeftEnd);
}

// Drag-to-resize from any corner — combines a vertical edge (top: grow upward
// keeping the bottom fixed / bottom: grow downward keeping the top fixed) with a
// horizontal edge (left / right). Floating panel, so all four corners resize.
type Corner = "tl" | "tr" | "bl" | "br";
const resizingCorner = ref<Corner | null>(null);
let cornerStartX = 0, cornerStartY = 0, cornerStartW = 0, cornerStartH = 0, cornerStartLeft = 0, cornerStartTop = 0;
function onResizeCornerStart(corner: Corner, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  cornerStartX    = e.clientX;
  cornerStartY    = e.clientY;
  cornerStartW    = tpRef.value?.offsetWidth ?? width.value;
  cornerStartH    = height.value;
  cornerStartLeft = left.value;
  cornerStartTop  = top.value;
  resizingCorner.value = corner;
  document.body.style.userSelect = "none";
  // tl/br share the ↘↖ axis, tr/bl share the ↗↙ axis.
  document.body.style.cursor = corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
  window.addEventListener("mousemove", onResizeCornerMove, { passive: false });
  window.addEventListener("mouseup",   onResizeCornerEnd);
}
function onResizeCornerMove(e: MouseEvent) {
  const corner = resizingCorner.value;
  if (!corner) return;
  e.preventDefault();
  const dx = e.clientX - cornerStartX;
  const dy = e.clientY - cornerStartY;
  // Vertical edge.
  if (corner === "tl" || corner === "tr") {
    // Top edge — grow upward, keep the bottom fixed.
    height.value = Math.max(120, cornerStartH - dy);
    top.value = Math.max(0, cornerStartTop + (cornerStartH - height.value));
  } else {
    // Bottom edge — grow downward, keep the top fixed.
    height.value = Math.max(120, cornerStartH + dy);
  }
  // Horizontal edge.
  const containerW = tpRef.value?.parentElement?.offsetWidth ?? window.innerWidth;
  if (corner === "tr" || corner === "br") {
    width.value = Math.max(300, Math.min(containerW - left.value, cornerStartW + dx));
  } else {
    const rightEdge = cornerStartLeft + cornerStartW; // fixed
    const newLeft = Math.max(0, Math.min(rightEdge - 300, cornerStartLeft + dx));
    left.value  = newLeft;
    width.value = rightEdge - newLeft;
  }
}
function onResizeCornerEnd() {
  localStorage.setItem(HEIGHT_KEY, String(height.value));
  localStorage.setItem(WIDTH_KEY,  String(width.value));
  localStorage.setItem(LEFT_KEY,   String(left.value));
  localStorage.setItem(TOP_KEY,    String(top.value));
  resizingCorner.value = null;
  document.body.style.userSelect = "";
  document.body.style.cursor     = "";
  window.removeEventListener("mousemove", onResizeCornerMove);
  window.removeEventListener("mouseup",   onResizeCornerEnd);
}

// Drag-to-resize from the bottom edge — grow downward, top fixed.
let bottomStartY = 0;
let bottomStartH = 0;
const isResizingBottom = ref(false);
function onResizeBottomStart(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  bottomStartY = e.clientY;
  bottomStartH = height.value;
  isResizingBottom.value = true;
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onResizeBottomMove, { passive: false });
  window.addEventListener("mouseup",   onResizeBottomEnd);
}
function onResizeBottomMove(e: MouseEvent) {
  if (!isResizingBottom.value) return;
  e.preventDefault();
  height.value = Math.max(120, bottomStartH + (e.clientY - bottomStartY));
}
function onResizeBottomEnd() {
  localStorage.setItem(HEIGHT_KEY, String(height.value));
  isResizingBottom.value = false;
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onResizeBottomMove);
  window.removeEventListener("mouseup",   onResizeBottomEnd);
}

onBeforeUnmount(() => {
  document.body.style.userSelect = "";
  document.body.style.cursor     = "";
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup",   onDragEnd);
  window.removeEventListener("mousemove", onMoveMove);
  window.removeEventListener("mouseup",   onMoveEnd);
  window.removeEventListener("mousemove", onResizeXMove);
  window.removeEventListener("mouseup",   onResizeXEnd);
  window.removeEventListener("mousemove", onResizeLeftMove);
  window.removeEventListener("mouseup",   onResizeLeftEnd);
  window.removeEventListener("mousemove", onResizeCornerMove);
  window.removeEventListener("mouseup",   onResizeCornerEnd);
  window.removeEventListener("mousemove", onResizeBottomMove);
  window.removeEventListener("mouseup",   onResizeBottomEnd);
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
    ref="tpRef"
    class="tp"
    :class="{ 'tp--full': fullscreen, 'tp--bottom': bottom, 'tp--floating': !fullscreen && !bottom }"
    :style="panelStyle"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown="onKeyDown"
  >
    <!-- Drag handle — drag upward to grow the panel (height-resizable modes) -->
    <div v-if="!fullscreen" class="tp__drag" :class="{ 'tp__drag--active': isDragging }" @mousedown="onDragStart" />

    <!-- Tab bar — drag on empty space to move the panel -->
    <div class="tp__tabs" @mousedown="onMoveStart">
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
      <button class="tp__hide" :title="t('terminal.hide')" @click="emit('close')">_</button>
      <button
        class="tp__full"
        :title="fullscreen ? t('terminal.exitFullscreen') : t('terminal.fullscreen')"
        :aria-label="fullscreen ? t('terminal.exitFullscreen') : t('terminal.fullscreen')"
        @click="toggleFullscreen"
      >
        <svg v-if="!fullscreen" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
          <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      </button>
    </div>

    <!-- Width / corner resize handles — floating mode only (fullscreen and
         bottom modes are width-locked). -->
    <template v-if="!fullscreen && !bottom">
      <!-- Left-edge resize handle -->
      <div
        class="tp__resize-x tp__resize-x--left"
        :class="{ 'tp__resize-x--active': isResizingL }"
        @mousedown="onResizeLeftStart"
      />

      <!-- Right-edge resize handle -->
      <div
        class="tp__resize-x"
        :class="{ 'tp__resize-x--active': isResizingX }"
        @mousedown="onResizeXStart"
      />

      <!-- Bottom-edge resize handle -->
      <div
        class="tp__resize-y tp__resize-y--bottom"
        :class="{ 'tp__resize-y--active': isResizingBottom }"
        @mousedown="onResizeBottomStart"
      />

      <!-- Corner resize handles (width + height together) -->
      <div
        class="tp__corner tp__corner--tl"
        :class="{ 'tp__corner--active': resizingCorner === 'tl' }"
        @mousedown="onResizeCornerStart('tl', $event)"
      />
      <div
        class="tp__corner tp__corner--tr"
        :class="{ 'tp__corner--active': resizingCorner === 'tr' }"
        @mousedown="onResizeCornerStart('tr', $event)"
      />
      <div
        class="tp__corner tp__corner--bl"
        :class="{ 'tp__corner--active': resizingCorner === 'bl' }"
        @mousedown="onResizeCornerStart('bl', $event)"
      />
      <div
        class="tp__corner tp__corner--br"
        :class="{ 'tp__corner--active': resizingCorner === 'br' }"
        @mousedown="onResizeCornerStart('br', $event)"
      />
    </template>

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
        <button class="tp__search-btn" @click="doSearch('prev')" :title="t('terminal.searchPrev')">↑</button>
        <button class="tp__search-btn" @click="doSearch('next')" :title="t('terminal.searchNext')">↓</button>
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
        <!-- No open tabs → keep the dark terminal surface with a hint. -->
        <div v-if="!tabs.length" class="tp__empty">
          {{ t('terminal.emptyHint') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tp {
  position: absolute;
  bottom: 0;
  /* left + width are set via :style binding */
  min-width: 300px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  background: color-mix(in srgb, var(--color-bg-tertiary) 88%, transparent);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-border-strong);
  border-bottom: none;
  box-shadow: var(--shadow-xl);
  z-index: 20;
}

.tp__drag {
  height: 5px;
  cursor: ns-resize;
  flex-shrink: 0;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  transition: background 0.15s;
}

.tp__drag:hover,
.tp__drag--active {
  background: transparent;
}

.tp__resize-x {
  position: absolute;
  top: 0;
  right: -4px;
  width: 8px;
  height: 100%;
  cursor: ew-resize;
  border-radius: 0 var(--radius-xl) 0 0;
  z-index: 1;
  transition: background 0.15s;
}

.tp__resize-x--left {
  right: auto;
  left: -4px;
  border-radius: var(--radius-xl) 0 0 0;
}

.tp__resize-x:hover,
.tp__resize-x--active {
  background: transparent;
}

/* Bottom-edge resize handle — grow the panel downward. */
.tp__resize-y {
  position: absolute;
  left: 0;
  width: 100%;
  height: 8px;
  cursor: ns-resize;
  z-index: 1;
  transition: background 0.15s;
}

.tp__resize-y--bottom {
  bottom: -4px;
}

.tp__resize-y:hover,
.tp__resize-y--active {
  background: transparent;
}

/* Corner resize grips — sit above the edge handles so the corner wins. */
.tp__corner {
  position: absolute;
  width: 14px;
  height: 14px;
  z-index: 2;
}

.tp__corner--tl {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}

.tp__corner--tr {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}

.tp__corner--bl {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}

.tp__corner--br {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}

.tp__tabs {
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 1px 6px 0px;
  margin-bottom: 0px;
  flex-shrink: 0;
  cursor: grab;
}

.tp__tabs:active {
  cursor: grabbing;
}

.tp__tab {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 7px 10px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: var(--bg-base, var(--color-bg));
  opacity: 0.7;
  border: none;
  cursor: pointer;
  color: inherit;
  font-size: var(--font-size-sm);
}

.tp__tab--active {
  background: var(--bg-base, var(--color-bg));
  opacity: 1 !important;
}

.tp__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
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
  border: none;
  cursor: pointer;
  padding: 7.5px 16px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  color: inherit;
  font-size: var(--font-size-lg);
  background: var(--bg-base, var(--color-bg));
  opacity: 0.7;
}

.tp__full {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--bg-base, var(--color-bg));
  opacity: 0.7;
  cursor: pointer;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  color: inherit;
  position: relative;
  top: -2px;
}

.tp__hide {
  margin-left: auto;
  border: none;
  background: var(--bg-base, var(--color-bg));
  opacity: 0.7;
  cursor: pointer;
  padding: 0px 13px 12px;
  border-radius: var(--radius-sm);
  color: inherit;
  font-size: var(--font-size-md);
  position: relative;
  top: -2px;
}

.tp__new:hover,
.tp__full:hover,
.tp__hide:hover,
.tp__tab:hover {
  background: var(--bg-base, var(--color-bg));
  opacity: 0.8;
}

/* Bottom — in-flow full-width docked aside. position:static drops it back into
   the flex flow (overriding the absolute base), so the sibling <main> shrinks
   and the content is pushed up — nothing hidden behind it. Flush chrome: solid
   surface, square corners, a single top border instead of the floating card. */
.tp--bottom {
  position: static;
  width: 100%;
  flex-shrink: 0;
  border: none;
  border-top: 1px solid var(--color-border-strong);
  border-radius: 0;
  background: var(--color-bg-tertiary);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
}

.tp--bottom .tp__drag {
  border-radius: 0;
}

/* Bottom mode is docked — the tab bar isn't a move handle. */
.tp--bottom .tp__tabs,
.tp--bottom .tp__tabs:active {
  cursor: default;
}

/* Floating — detached overlay, round all four corners + close the bottom border. */
.tp--floating {
  border-radius: var(--radius-lg);
  border-bottom: 1px solid var(--color-border-strong);
}

/* Fullscreen — fill the app-body; square the top corners. The drag handle is
   hidden in this mode, so add its headroom back to the tab bar (the tab buttons
   sit at top:-2px and would otherwise clip at the panel's top edge). */
.tp--full {
  border-radius: 0;
}

.tp--full .tp__tabs {
  padding-top: 6px;
}

.tp--full .tp__drag {
  border-radius: 0;
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
  inset: 0px 6px 7px;
  padding: 0px 7px;
  background-color: black;
  border-radius: 0px var(--radius-sm) var(--radius-sm) var(--radius-sm);
}

.tp__empty {
  position: absolute;
  inset: 0px 6px 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: black;
  border-radius: 0px var(--radius-sm) var(--radius-sm) var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--font-size-xl);
  user-select: none;
}

.terminal {
  padding: 5px;
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
