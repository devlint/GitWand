<script setup lang="ts">
/**
 * RepoTabStrip — replaces RepoTabBar in the new header layout.
 *
 * What changes vs. RepoTabBar
 * ───────────────────────────
 *  - Always visible when ≥ 1 tab is open (same as before, unchanged).
 *  - "+" button sits immediately after the last tab, browser-tab style —
 *    no more `margin-left: auto` pushing it to the far right.
 *  - Intended to live ABOVE the logo/header row (stacking), so the
 *    component now renders a plain inline strip instead of a full-width
 *    bar with its own background. The parent owns the wrapping bar.
 *
 * Behaviour kept from RepoTabBar
 * ──────────────────────────────
 *  - Middle-click closes a tab.
 *  - `closeOtherTabs` event kept for forwards-compat even though the
 *    context menu isn't wired yet — removing the event would be an
 *    unrelated breaking change.
 *
 * Behaviour changed from RepoTabBar
 * ─────────────────────────────────
 *  - The active tab chip is rendered even in single-tab mode (browser-
 *    style), instead of showing just the "+". This keeps the current
 *    repo visible in the header and makes the close affordance reachable
 *    without requiring the user to first open a second tab.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { RepoTab } from "../../composables/useRepoTabs";
import type { WorktreeEntry } from "../../utils/backend";
import { useI18n } from "../../composables/useI18n";
import { useFolderHistory } from "../../composables/useFolderHistory";

const { t } = useI18n();
const { history: repoHistory } = useFolderHistory();

const props = defineProps<{
  tabs: RepoTab[];
  activeTabId: number | null;
  /** Path of the active checkout (project root, or a selected worktree). */
  activeRepoPath?: string | null;
  /** Loads a project's worktrees for the per-project submenu. */
  loadWorktrees?: (projectPath: string) => Promise<WorktreeEntry[]>;
  /** Project paths that have ≥1 extra worktree — only these show the caret. */
  worktreeProjectPaths?: Set<string>;
}>();

/** Whether a project has worktrees worth showing the submenu caret for. */
function hasWorktrees(path: string): boolean {
  return props.worktreeProjectPaths?.has(path) ?? false;
}

const emit = defineEmits<{
  switchTab: [tabId: number];
  closeTab: [tabId: number];
  selectWorktree: [payload: { tabId: number; path: string }];
  deleteWorktree: [payload: { path: string; projectPath: string; branch: string }];
  newTab: [];
  openClone: [];
  openFork: [];
  openRecent: [path: string];
  closeOtherTabs: [tabId: number];
  reorderTabs: [oldIndex: number, newIndex: number];
}>();

/** A `gitwand-scratch-*` worktree gets the AI badge + a delete affordance. */
function isScratch(path: string): boolean {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return base.startsWith("gitwand-scratch-");
}

// ─── Drag to reorder — pointer-based ─────────────────────
// Native HTML5 drag-and-drop is unreliable in WebKit (WKWebView on macOS,
// WebKitGTK on Linux — both power the packaged Tauri app): `dragstart`
// frequently never fires, so the tabs couldn't be reordered and no drop
// indicator showed. Pointer events drive it instead — one code path for
// mouse, touch and pen — and the gesture is claimed via setPointerCapture so
// a native touch-scroll can't steal it mid-drag. draggedIndex / hoveredIndex
// keep the same meaning the CSS classes expect (source index / hovered
// target).
const draggedIndex = ref<number | null>(null);
const hoveredIndex = ref<number | null>(null);
const stripEl = ref<HTMLElement | null>(null);
// Live horizontal offset of the tab being dragged, so it tracks the cursor.
const dragOffsetX = ref(0);
/** Rendered by the aria-live region — feedback for a keyboard reorder. */
const announceText = ref("");

// A press only becomes a drag past this threshold, so a plain click/tap
// still switches tabs instead of being swallowed as a (zero-distance) drag.
const DRAG_THRESHOLD_PX = 4;
// How far above/below the strip the cursor can stray before a release reads
// as "dropped outside" (cancelled) rather than a reorder.
const DRAG_VERTICAL_TOLERANCE_PX = 40;
let pressIndex: number | null = null;
let pressStartX = 0;
let didDrag = false;
// The element/pointer a drag claimed via setPointerCapture, so it can be
// released again in finishDrag. Capture is best-effort: some webviews don't
// implement it, so every use is feature-detected and wrapped in try/catch.
let capturedEl: HTMLElement | null = null;
let capturedPointerId: number | null = null;
// Center-x of each tab captured when the drag begins. The dragged tab gets a
// translateX to follow the cursor, which would move its own bounding rect — so
// we hit-test against this snapshot (the other tabs don't move until drop).
let tabCenters: number[] = [];

function snapshotCenters() {
  const root = stripEl.value;
  tabCenters = root
    ? Array.from(root.querySelectorAll<HTMLElement>(".repo-tab")).map((el, i) => {
        const r = el.getBoundingClientRect();
        const center = r.left + r.width / 2;
        // The dragged tab renders with a live translateX so it visually
        // tracks the pointer; a re-snapshot mid-drag (scroll, resize) would
        // otherwise measure that offset baked into its rect and then add
        // dragOffsetX on top of it a second time in indexForDragOffset —
        // strip it back out so this always holds each tab's *resting*
        // position, exactly like the very first snapshot (taken at offset 0,
        // before any transform is rendered).
        return i === draggedIndex.value ? center - dragOffsetX.value : center;
      })
    : [];
}

/**
 * Index of the slot the dragged tab's own (shifted) center now sits in,
 * i.e. how many of the *other* tabs' (unmoving) centers it has been dragged
 * past. Hit-testing against the dragged tab's own current center — its
 * drag-start center plus the live offset — rather than the raw cursor
 * position means a press anywhere within the tab (left half or right half)
 * starts at offset 0, so a few pixels of hand wobble can't immediately swap
 * it with a neighbour just because the press happened to land past its
 * midpoint. Excluding the dragged tab's own original center from the count
 * matters too: comparing against the full list would have that slot count
 * against itself at offset 0, overshooting straight to `draggedIndex + 1`
 * before any real movement happened.
 */
function indexForDragOffset(offsetX: number): number | null {
  if (tabCenters.length === 0 || draggedIndex.value === null) return null;
  const draggedCenter = tabCenters[draggedIndex.value] + offsetX;
  let index = 0;
  for (let i = 0; i < tabCenters.length; i++) {
    if (i === draggedIndex.value) continue;
    if (tabCenters[i] < draggedCenter) index++;
  }
  return index;
}

function onStripScroll() {
  // Centers are snapshotted in viewport coordinates; scrolling the strip
  // (it's overflow-x: auto) mid-drag shifts every tab, so re-snapshot to
  // keep the hit-test honest.
  if (didDrag) snapshotCenters();
}

function onTabPointerDown(e: PointerEvent, index: number, tabId: number) {
  if (e.button === 1) {
    // Middle-click closes, same as before.
    e.preventDefault();
    emit("closeTab", tabId);
    return;
  }
  if (e.button !== 0) return;
  // Don't start a drag from the close affordance. (The caret already stops
  // propagation on its own @pointerdown, so it never reaches this handler.)
  if ((e.target as Element).closest?.(".repo-tab__close")) return;
  pressIndex = index;
  pressStartX = e.clientX;
  didDrag = false;
  capturedEl = e.currentTarget as HTMLElement;
  capturedPointerId = e.pointerId;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);
  window.addEventListener("blur", onDragCancel);
}

function onDragMove(e: PointerEvent) {
  if (pressIndex === null) return;
  if (!didDrag) {
    if (Math.abs(e.clientX - pressStartX) < DRAG_THRESHOLD_PX) return;
    didDrag = true;
    draggedIndex.value = pressIndex;
    snapshotCenters();
    // Claim the gesture so pointermove/pointerup keep targeting this tab
    // even once the pointer leaves it — guards against a native touch-pan
    // gesture on the strip's own overflow-x scroll winning the race and
    // hijacking the drag partway through.
    if (capturedEl && typeof capturedEl.setPointerCapture === "function") {
      try {
        capturedEl.setPointerCapture(e.pointerId);
      } catch {
        // Best-effort — the window listeners still drive the drag without it.
      }
    }
  }
  // Suppress the text selection / touch-scroll a drag would otherwise paint
  // over the tab labels and neighbouring header content.
  e.preventDefault();
  dragOffsetX.value = e.clientX - pressStartX;
  const stripRect = stripEl.value?.getBoundingClientRect();
  const droppedOutside =
    !!stripRect &&
    (e.clientY < stripRect.top - DRAG_VERTICAL_TOLERANCE_PX ||
      e.clientY > stripRect.bottom + DRAG_VERTICAL_TOLERANCE_PX);
  // Cursor well above/below the strip (over app content, a native title bar,
  // etc.) reads as "no drop target" — mirrors the old native DnD, where
  // dragging outside any drop zone left the tab order untouched.
  hoveredIndex.value = droppedOutside ? null : indexForDragOffset(dragOffsetX.value);
}

/** Detaches the drag's window listeners and resets its transient state. */
function finishDrag(commit: boolean) {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragCancel);
  window.removeEventListener("blur", onDragCancel);
  if (capturedEl && capturedPointerId !== null && typeof capturedEl.releasePointerCapture === "function") {
    try {
      capturedEl.releasePointerCapture(capturedPointerId);
    } catch {
      // Already released (e.g. the browser dropped it and fired
      // pointercancel first) — nothing left to release.
    }
  }
  capturedEl = null;
  capturedPointerId = null;
  if (
    commit &&
    didDrag &&
    draggedIndex.value !== null &&
    hoveredIndex.value !== null &&
    hoveredIndex.value !== draggedIndex.value
  ) {
    emit("reorderTabs", draggedIndex.value, hoveredIndex.value);
  }
  pressIndex = null;
  draggedIndex.value = null;
  hoveredIndex.value = null;
  dragOffsetX.value = 0;
  tabCenters = [];
  // The click that follows a pointerup on the same element fires
  // synchronously in the same task, before this timeout runs — so it's still
  // suppressed below. Resetting on a deferred tick, rather than relying on
  // that click reaching onTabClick, means the flag can't get stuck when the
  // release lands off the dragged tab, which would otherwise swallow the
  // very next keyboard tab activation.
  setTimeout(() => {
    didDrag = false;
  }, 0);
}

function onDragEnd(e: PointerEvent) {
  // Only the button that can start a drag can end it — a right/middle-click
  // released mid-drag (e.g. after a middle-click closed a different tab)
  // must not commit or abort this one. Touch/pen contacts report button 0,
  // same as a left click, so this doesn't affect them.
  if (e.button !== 0) return;
  finishDrag(true);
}

function onDragCancel() {
  finishDrag(false);
}

// A tab opening/closing mid-drag (deep link, programmatic close, …) leaves
// draggedIndex/hoveredIndex and the center snapshot pointing at stale
// positions — abort rather than risk committing a reorder against them.
watch(
  () => props.tabs.length,
  () => {
    if (pressIndex !== null) onDragCancel();
  },
);

// ─── Keyboard reordering ─────────────────────────────────
// The pointer/touch drag above has no keyboard equivalent, which would
// otherwise leave reordering unreachable without a mouse, trackpad or
// touchscreen. Ctrl/Cmd+Shift+ArrowLeft/Right nudges the focused tab one slot
// at a time; the aria-live region above announces the result since the
// reorder is a silent DOM move with nothing else for a screen reader to key
// off of.
//
// Bare Ctrl/Cmd+ArrowLeft/Right was tried first and rejected: on macOS,
// Ctrl+Arrow is the *default* Mission Control "switch Space" shortcut,
// handled by the OS before the keydown ever reaches any app — including a
// browser, so it's not a Tauri-specific gap. Cmd+Arrow isn't bound by
// default, but plenty of window-manager utilities (Rectangle, yabai, …) and
// user remaps claim bare Cmd/Ctrl+Arrow too. Requiring Shift as well avoids
// every OS-level and third-party shortcut we know of for this combo — the
// same reasoning VS Code's editor-move commands are bound to Shift-modified
// combos rather than a bare arrow.
async function moveFocusedTab(index: number, tab: RepoTab, direction: -1 | 1) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= props.tabs.length) return;
  emit("reorderTabs", index, newIndex);
  announceText.value = t("header.tabStripReorderAnnounce", tab.name, newIndex + 1, props.tabs.length);
  // `tabs` is keyed by `tab.id`, so Vue moves the same DOM node rather than
  // recreating it and focus should already follow — but re-focus explicitly
  // by id once the reorder lands, in case the parent re-renders the list.
  await nextTick();
  stripEl.value?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"]`)?.focus();
}

function onTabKeydown(e: KeyboardEvent, index: number, tab: RepoTab) {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    moveFocusedTab(index, tab, -1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    moveFocusedTab(index, tab, 1);
  }
}

// Pinned and recent repos shown in the + dropdown (excludes repos already
// open in a tab). Capped at 8 combined entries so the menu stays compact;
// pinned items always win a slot, the remainder goes to recents.
const MAX_DROPDOWN_ENTRIES = 8;

const dropdownEntries = computed(() => {
  const openPaths = new Set(props.tabs.map((t) => t.path));
  const eligible = repoHistory.value.filter((e) => !openPaths.has(e.path));
  const pinned = eligible.filter((e) => e.pinned);
  const recent = eligible.filter((e) => !e.pinned);
  const pinnedSlice = pinned.slice(0, MAX_DROPDOWN_ENTRIES);
  const recentSlice = recent.slice(0, MAX_DROPDOWN_ENTRIES - pinnedSlice.length);
  return { pinned: pinnedSlice, recent: recentSlice };
});

const pinnedRepos = computed(() => dropdownEntries.value.pinned);
const recentRepos = computed(() => dropdownEntries.value.recent);
const hasAnyRepo = computed(
  () => pinnedRepos.value.length > 0 || recentRepos.value.length > 0,
);

// ─── + button dropdown (v2.0) ────────────────────────────
//
// The strip itself sets `overflow-x: auto` for horizontal tab scrolling,
// which forces a `overflow-y` clip too — meaning a regular absolute-positioned
// dropdown anchored to the + button is silently clipped (the menu opens but
// is invisible because it falls below the strip's content edge). Fix:
// teleport the menu to <body>, position it via getBoundingClientRect, and
// extend the click-outside test to count the (now-detached) menu as inside.
const showMenu = ref(false);
const wrapperEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

function updateMenuPosition() {
  const el = wrapperEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  menuStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
  };
}

function toggleMenu() {
  showMenu.value = !showMenu.value;
}

function closeMenu() {
  showMenu.value = false;
}

function pickAction(action: "newTab" | "openClone" | "openFork") {
  closeMenu();
  if (action === "newTab") emit("newTab");
  else if (action === "openClone") emit("openClone");
  else emit("openFork");
}

function onDocumentClick(e: MouseEvent) {
  const target = e.target as (Node & Element) | null;
  if (!target) return;
  if (showMenu.value) {
    // Click is "inside" if it's on the trigger wrapper or anywhere in the
    // teleported menu — treat both as in-bounds so the menu doesn't close
    // before the item's @click handler fires.
    if (!wrapperEl.value?.contains(target) && !menuEl.value?.contains(target)) {
      closeMenu();
    }
  }
  if (wtMenuTabId.value !== null) {
    // The caret — and the active chip itself — toggle the menu on click, so
    // don't pre-close here or the toggle would immediately reopen it.
    const onCaret = !!(target as Element).closest?.(".repo-tab__caret");
    const onActiveChip = !!(target as Element).closest?.(".repo-tab--active");
    if (!onCaret && !onActiveChip && !wtMenuEl.value?.contains(target)) {
      closeWorktreeMenu();
    }
  }
}

function onDocumentKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (showMenu.value) closeMenu();
  if (wtMenuTabId.value !== null) closeWorktreeMenu();
  if (pressIndex !== null) onDragCancel();
}

// Reposition when the menu opens — and close on resize / strip scroll
// rather than trying to re-anchor mid-flight (would feel jittery).
watch(showMenu, (open) => {
  if (open) nextTick(() => updateMenuPosition());
});

function onWindowChange() {
  if (showMenu.value) closeMenu();
  if (wtMenuTabId.value !== null) closeWorktreeMenu();
  // A window resize (or a zoom-level change) shifts every tab's viewport
  // position exactly like a strip scroll would — re-snapshot so the
  // hit-test in onDragMove keeps hit-testing against live centers.
  if (didDrag) snapshotCenters();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocumentClick);
  document.addEventListener("keydown", onDocumentKey);
  window.addEventListener("resize", onWindowChange);
  window.addEventListener("scroll", onWindowChange, true);
  stripEl.value?.addEventListener("scroll", onStripScroll, { passive: true });
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKey);
  window.removeEventListener("resize", onWindowChange);
  window.removeEventListener("scroll", onWindowChange, true);
  stripEl.value?.removeEventListener("scroll", onStripScroll);
  // Guard against unmounting mid-drag leaking the window listeners.
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragCancel);
  window.removeEventListener("blur", onDragCancel);
});

/**
 * Strip renders as soon as at least one repo is open. Unlike the old
 * RepoTabBar, we also render the active tab's chip in single-tab mode —
 * the browser-tab aesthetic is all about "you can see your context even
 * when there's just one" and it makes multi-repo support discoverable
 * without requiring a click on "+".
 */
const showStrip = computed(() => props.tabs.length >= 1);
const showTabs = computed(() => props.tabs.length >= 1);

// ─── Per-project worktree submenu ────────────────────────
// The caret on each project chip opens a dropdown listing `main` + the
// project's worktrees. Selecting one switches that project's checkout in
// place; scratch worktrees additionally get a delete affordance. Like the
// "+" menu, the dropdown is teleported to <body> to escape the strip's
// overflow clipping and positioned from the caret's bounding rect.
const wtMenuTabId = ref<number | null>(null);
const wtMenuProjectPath = ref<string>("");
const wtMenuEl = ref<HTMLElement | null>(null);
const wtMenuStyle = ref<Record<string, string>>({});
const wtItems = ref<WorktreeEntry[]>([]);
const wtLoading = ref(false);

/** Worktree rows (everything that isn't the main worktree or a stale entry). */
const wtWorktrees = computed(() =>
  wtItems.value.filter((w) => !w.is_main && !w.is_prunable),
);

/** The main worktree's on-disk path (falls back to the project path). */
const wtMainPath = computed(
  () => wtItems.value.find((w) => w.is_main)?.path ?? wtMenuProjectPath.value,
);

function isRowActive(path: string): boolean {
  return wtMenuTabId.value === props.activeTabId && props.activeRepoPath === path;
}

function worktreeLabel(w: WorktreeEntry): string {
  return w.branch || (w.path.replace(/\/+$/, "").split("/").pop() ?? w.path);
}

async function toggleWorktreeMenu(e: MouseEvent, tab: RepoTab) {
  if (wtMenuTabId.value === tab.id) {
    closeWorktreeMenu();
    return;
  }
  closeMenu(); // close the "+" menu if open
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  wtMenuStyle.value = { top: `${rect.bottom + 4}px`, left: `${rect.left}px` };
  wtMenuTabId.value = tab.id;
  wtMenuProjectPath.value = tab.path;
  wtItems.value = [];
  if (!props.loadWorktrees) return;
  wtLoading.value = true;
  try {
    wtItems.value = await props.loadWorktrees(tab.path);
  } catch {
    wtItems.value = [];
  } finally {
    wtLoading.value = false;
  }
}

function closeWorktreeMenu() {
  wtMenuTabId.value = null;
}

function pickWorktree(path: string) {
  const tabId = wtMenuTabId.value;
  closeWorktreeMenu();
  if (tabId === null) return;
  emit("selectWorktree", { tabId, path });
}

function removeWorktree(w: WorktreeEntry) {
  const projectPath = wtMenuProjectPath.value;
  closeWorktreeMenu();
  emit("deleteWorktree", { path: w.path, projectPath, branch: worktreeLabel(w) });
}

/**
 * Clicking a tab switches to it. Clicking the tab that's already active opens
 * (toggles) its worktree submenu — a second, larger hit target than the small
 * caret for the same action.
 */
function onTabClick(e: MouseEvent, tab: RepoTab) {
  // A drag just ended — swallow the trailing click so it doesn't switch tabs.
  if (didDrag) {
    didDrag = false;
    return;
  }
  if (tab.id === props.activeTabId) {
    if (hasWorktrees(tab.path)) toggleWorktreeMenu(e, tab);
    return;
  }
  emit("switchTab", tab.id);
}

function onCloseClick(e: MouseEvent, tabId: number) {
  e.stopPropagation();
  emit("closeTab", tabId);
}
</script>

<template>
  <div v-if="showStrip" ref="stripEl" class="repo-tab-strip" role="tablist">
    <!-- Announces the result of a keyboard reorder (Ctrl/Cmd+Shift+Arrow) —
         the move itself is a silent DOM splice with nothing else for a
         screen reader to react to. -->
    <span class="repo-tab-strip__sr-only" role="status" aria-live="polite">{{ announceText }}</span>
    <!-- Tabs — rendered only when there are multiple repos -->
    <template v-if="showTabs">
      <!-- Reordered via pointer events (see onTabPointerDown) — covers mouse,
           touch and pen in one path — rather than native HTML5 drag, which is
           unreliable in the WebKit webviews powering the app.
           Ctrl/Cmd+Shift+Arrow reorders from the keyboard (see
           onTabKeydown) since the pointer gesture has no keyboard
           equivalent otherwise — Shift is required alongside Ctrl/Cmd
           because a bare Ctrl+Arrow is macOS's default Mission Control
           "switch Space" shortcut and never reaches the app at all. -->
      <button
        v-for="(tab, index) in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="repo-tab"
        :class="{
          'repo-tab--active': tab.id === activeTabId,
          'repo-tab--menu-open': wtMenuTabId === tab.id,
          'repo-tab--dragging': draggedIndex === index,
          'repo-tab--drag-over-left': hoveredIndex === index && draggedIndex !== null && draggedIndex > index,
          'repo-tab--drag-over-right': hoveredIndex === index && draggedIndex !== null && draggedIndex < index
        }"
        :aria-selected="tab.id === activeTabId ? 'true' : 'false'"
        :aria-keyshortcuts="tabs.length > 1 ? 'Control+Shift+ArrowLeft Control+Shift+ArrowRight Meta+Shift+ArrowLeft Meta+Shift+ArrowRight' : undefined"
        :data-tab-id="tab.id"
        :title="tab.path"
        :style="draggedIndex === index ? { transform: `translateX(${dragOffsetX}px)` } : null"
        @click="(e) => onTabClick(e, tab)"
        @pointerdown="(e) => onTabPointerDown(e, index, tab.id)"
        @keydown="(e) => onTabKeydown(e, index, tab)"
      >
        <svg class="repo-tab__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 013.5 2h3.586a1.5 1.5 0 011.06.44l.915.914a1 1 0 00.707.293H12.5A1.5 1.5 0 0114 5.147V12.5A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <span class="repo-tab__name">{{ tab.name }}</span>
        <!-- Worktree submenu caret — span (not button) to stay valid inside the
             chip's own <button>. Sits between the name and the close affordance.
             Hidden when the project has no extra worktrees. -->
        <span
          v-if="hasWorktrees(tab.path) || wtMenuTabId === tab.id"
          class="repo-tab__caret"
          role="button"
          tabindex="-1"
          :aria-label="t('worktree.menuLabel')"
          :aria-expanded="wtMenuTabId === tab.id ? 'true' : 'false'"
          aria-haspopup="menu"
          @click.stop="(e) => toggleWorktreeMenu(e, tab)"
          @pointerdown.stop
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 3.5L5 6.5L8 3.5" />
          </svg>
        </span>
        <span
          class="repo-tab__close"
          role="button"
          tabindex="-1"
          aria-label="Close tab"
          @click="(e) => onCloseClick(e, tab.id)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
            <path d="M2.354 2.354a.5.5 0 01.707 0L5 4.293l1.94-1.94a.5.5 0 01.706.708L5.707 5l1.94 1.94a.5.5 0 01-.707.706L5 5.707l-1.94 1.94a.5.5 0 01-.706-.707L4.293 5l-1.94-1.94a.5.5 0 010-.706z" />
          </svg>
        </span>
      </button>
    </template>

    <!-- + button: opens a dropdown with Open folder / Clone / Fork (v2.0) -->
    <div ref="wrapperEl" class="repo-tab-new-wrap">
      <button
        type="button"
        class="repo-tab-new"
        :class="{ 'repo-tab-new--open': showMenu }"
        :title="t('header.tabStripAddTitle')"
        :aria-label="t('header.tabStripAddTitle')"
        :aria-expanded="showMenu"
        aria-haspopup="menu"
        @click="toggleMenu"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <path d="M7 1.5a.5.5 0 01.5.5v4.5H12a.5.5 0 010 1H7.5V12a.5.5 0 01-1 0V7.5H2a.5.5 0 010-1h4.5V2a.5.5 0 01.5-.5z" />
        </svg>
      </button>
    </div>
    <!-- Dropdown menu — teleported to <body> to escape the tab strip's
         overflow clipping. Positioned via inline style relative to the
         button wrapper's bounding rect (recomputed on open). -->
    <Teleport to="body">
      <div
        v-if="showMenu"
        ref="menuEl"
        class="repo-tab-new-menu"
        role="menu"
        :style="menuStyle"
      >
        <button
          type="button"
          role="menuitem"
          class="repo-tab-new-item"
          @click="pickAction('newTab')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 3.5A1.5 1.5 0 013.5 2H6l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.5" />
          </svg>
          {{ t('header.tabStripOpenFolder') }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="repo-tab-new-item"
          @click="pickAction('openClone')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {{ t('header.tabStripClone') }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="repo-tab-new-item"
          @click="pickAction('openFork')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="6" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
            <circle cx="18" cy="5" r="2.2" stroke="currentColor" stroke-width="1.6" />
            <circle cx="12" cy="19" r="2.2" stroke="currentColor" stroke-width="1.6" />
            <path d="M6 7.2v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <path d="M12 13.2v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          {{ t('header.tabStripFork') }}
        </button>

        <!--
          Pinned + Recent sections. The separator + label combo is rendered
          only if the corresponding list is non-empty, so we never leak an
          orphan <hr> when the user has no history yet. Pinned comes first,
          then a secondary separator before recents (only if both exist).
        -->
        <template v-if="hasAnyRepo">
          <div class="repo-tab-new-separator" role="separator" aria-hidden="true"></div>
          <div v-if="pinnedRepos.length > 0" class="repo-tab-new-section">
            <div class="repo-tab-new-section-label">{{ t('header.tabStripPinnedSection') }}</div>
            <button
              v-for="entry in pinnedRepos"
              :key="entry.path"
              type="button"
              role="menuitem"
              class="repo-tab-new-item repo-tab-new-item--recent"
              :title="entry.path"
              @click="closeMenu(); emit('openRecent', entry.path)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 3.5A1.5 1.5 0 013.5 2h3.586a1.5 1.5 0 011.06.44l.915.914a1 1 0 00.707.293H12.5A1.5 1.5 0 0114 5.147V12.5A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.2" />
              </svg>
              <span class="repo-tab-new-item__text">
                <span class="repo-tab-new-item__name">{{ entry.name }}</span>
                <span class="repo-tab-new-item__path">{{ entry.path }}</span>
              </span>
              <span class="repo-tab-new-item__pin" aria-hidden="true">★</span>
            </button>
          </div>
          <div
            v-if="pinnedRepos.length > 0 && recentRepos.length > 0"
            class="repo-tab-new-separator repo-tab-new-separator--inner"
            role="separator"
            aria-hidden="true"
          ></div>
          <div v-if="recentRepos.length > 0" class="repo-tab-new-section">
            <div class="repo-tab-new-section-label">{{ t('header.tabStripRecentSection') }}</div>
            <button
              v-for="entry in recentRepos"
              :key="entry.path"
              type="button"
              role="menuitem"
              class="repo-tab-new-item repo-tab-new-item--recent"
              :title="entry.path"
              @click="closeMenu(); emit('openRecent', entry.path)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 3.5A1.5 1.5 0 013.5 2h3.586a1.5 1.5 0 011.06.44l.915.914a1 1 0 00.707.293H12.5A1.5 1.5 0 0114 5.147V12.5A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.2" />
              </svg>
              <span class="repo-tab-new-item__text">
                <span class="repo-tab-new-item__name">{{ entry.name }}</span>
                <span class="repo-tab-new-item__path">{{ entry.path }}</span>
              </span>
            </button>
          </div>
        </template>
      </div>
    </Teleport>

    <!-- Per-project worktree submenu — teleported to <body> like the "+" menu. -->
    <Teleport to="body">
      <div
        v-if="wtMenuTabId !== null"
        ref="wtMenuEl"
        class="repo-tab-new-menu repo-wt-menu"
        role="menu"
        :style="wtMenuStyle"
      >
        <div class="repo-tab-new-section-label">{{ t('worktree.menuTitle') }}</div>

        <!-- main -->
        <button
          type="button"
          role="menuitem"
          class="repo-tab-new-item repo-wt-item"
          :class="{ 'repo-wt-item--active': isRowActive(wtMainPath) }"
          @click="pickWorktree(wtMainPath)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 3.5A1.5 1.5 0 013.5 2h3.586a1.5 1.5 0 011.06.44l.915.914a1 1 0 00.707.293H12.5A1.5 1.5 0 0114 5.147V12.5A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <span class="repo-tab-new-item__text">
            <span class="repo-tab-new-item__name">{{ t('worktree.menuMain') }}</span>
          </span>
          <span v-if="isRowActive(wtMainPath)" class="repo-wt-check" aria-hidden="true">✓</span>
        </button>

        <!-- worktrees -->
        <div v-if="wtLoading" class="repo-wt-state">{{ t('common.loading') }}</div>
        <template v-else>
          <div
            v-for="w in wtWorktrees"
            :key="w.path"
            class="repo-wt-row"
            :class="{ 'repo-wt-item--active': isRowActive(w.path) }"
          >
            <button
              type="button"
              role="menuitem"
              class="repo-tab-new-item repo-wt-item repo-wt-item--grow"
              :title="w.path"
              @click="pickWorktree(w.path)"
            >
              <svg v-if="isScratch(w.path)" class="repo-wt-icon--ai" width="14" height="14" viewBox="0 0 24 24"
                fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.6 4.8a4 4 0 0 0 2.6 2.6L21 11l-4.8 1.6a4 4 0 0 0-2.6 2.6L12 20l-1.6-4.8a4 4 0 0 0-2.6-2.6L3 11l4.8-1.6a4 4 0 0 0 2.6-2.6L12 2z" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="5" cy="3" r="1.5" />
                <circle cx="5" cy="13" r="1.5" />
                <circle cx="11" cy="6" r="1.5" />
                <path d="M5 4.5v7M5 4.5C5 7 11 7.5 11 6" />
              </svg>
              <span class="repo-tab-new-item__text">
                <span class="repo-tab-new-item__name">{{ worktreeLabel(w) }}</span>
              </span>
              <span v-if="isRowActive(w.path)" class="repo-wt-check" aria-hidden="true">✓</span>
            </button>
            <button
              v-if="isScratch(w.path)"
              type="button"
              class="repo-wt-delete"
              :title="t('worktree.menuRemove')"
              :aria-label="t('worktree.menuRemove')"
              @click.stop="removeWorktree(w)"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4M6 7v4M10 7v4" />
              </svg>
            </button>
          </div>
          <div v-if="wtWorktrees.length === 0" class="repo-wt-state">{{ t('worktree.menuEmpty') }}</div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* The strip is an inline container; the parent (AppHeader) owns the
   surrounding bar's background, padding and border. Keeping this
   component chrome-less lets the parent compose tabs + logo + header
   row without fighting nested backgrounds. */
.repo-tab-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
  /* Horizontal scroll when many tabs accumulate — prevents the strip
     from pushing the "+" off-screen. */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  padding: 0 4px;
}

/* Tabs are pills, matching the rest of the header's chip vocabulary
   (branch-trigger, action buttons). The old "browser-tab" bottom-edge
   trick is out — it fought the parent bar's own border and looked
   floating on dark backgrounds. Active state is marked with a tinted
   background + accent color, same language as segmented controls. */
.repo-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: transparent;
  /* Transparent by default so the active chip (below) and inactive chips share
     the same box size — inactive tabs colour this border in. */
  border: 1px solid transparent;
  cursor: pointer;
  transition: color var(--transition-base), background var(--transition-base), border-color var(--transition-base);
  max-width: 200px;
  min-width: 0;
  flex-shrink: 1;
  user-select: none;
  white-space: nowrap;
  /* Claim horizontal pan gestures ourselves (pointer-based drag-to-reorder)
     instead of letting a touch/pen device start the strip's native
     overflow-x scroll first — that native gesture can otherwise win the
     race and hijack the drag before our own pointermove handler ever sees
     it move. Horizontal scrolling by touch still works from the strip's own
     padding or empty space between tabs. */
  touch-action: none;
}

/* Visually hidden but still reachable by screen readers — used for the
   aria-live reorder announcement, which must never be visible. */
.repo-tab-strip__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

/* Inactive tabs get a faint outline so they read as distinct chips and their
   caret / close affordances feel reachable even without hovering. */
.repo-tab:not(.repo-tab--active) {
  border-color: color-mix(in srgb, var(--color-border) 45%, transparent);
}

.repo-tab:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.repo-tab--active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.repo-tab--dragging {
  cursor: grabbing;
  /* Lifted above its neighbours and following the cursor via an inline
     translateX. No transform transition here so it tracks the pointer 1:1. */
  position: relative;
  z-index: 3;
  opacity: 0.3;
  background: var(--color-bg-tertiary);
  box-shadow: var(--shadow-md);
  transition: none;
}

.repo-tab--drag-over-left,
.repo-tab--drag-over-right {
  position: relative;
}

.repo-tab--drag-over-left::before,
.repo-tab--drag-over-right::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 2px;
  height: 24px;
  background: var(--color-accent);
  border-radius: var(--radius-pill);
  transform: translateY(-50%);
  pointer-events: none;
  z-index: 2;
}

.repo-tab--drag-over-left::before {
  left: -3px;
}

.repo-tab--drag-over-right::after {
  right: -3px;
}

.repo-tab__icon {
  flex-shrink: 0;
  opacity: 0.65;
}

.repo-tab--active .repo-tab__icon {
  opacity: 1;
  color: var(--color-accent);
}

/* Worktree submenu caret — sits between the name and the close button. Like
   the close affordance, it reveals on hover / active and is a span (not a
   button) to stay valid inside the chip's own <button>. */
.repo-tab__caret {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  /* Follow the chip's own color logic, exactly like .repo-tab__name:
     muted by default, text on chip hover, accent when active. */
  color: inherit;
  opacity: 0.4;
  cursor: pointer;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  margin: 0px -5px;
}

.repo-tab:hover .repo-tab__caret,
.repo-tab--active .repo-tab__caret,
.repo-tab--menu-open .repo-tab__caret {
  opacity: 0.7;
}

.repo-tab__caret:hover {
  /* Font color stays driven by chip state (like the name); only the
     background reacts to hovering the caret itself. */
  opacity: 1 !important;
  background: var(--color-bg-tertiary);
}

.repo-tab--menu-open {
  background: var(--color-bg-tertiary);
}

/* ── Worktree submenu ─────────────────────────────────── */
.repo-wt-menu {
  min-width: 220px;
}

.repo-wt-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--radius-sm);
}

.repo-wt-item {
  width: 100%;
}

.repo-wt-item--grow {
  flex: 1;
  min-width: 0;
}

.repo-wt-item--active,
.repo-wt-row.repo-wt-item--active {
  background: var(--color-accent-soft);
}

.repo-wt-item--active .repo-tab-new-item__name {
  color: var(--color-accent);
}

.repo-wt-icon--ai {
  color: var(--color-accent);
}

.repo-wt-check {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-accent);
}

.repo-wt-delete {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.repo-wt-delete:hover {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.repo-wt-state {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.repo-tab__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* Close affordance — only visible on hover / active, like browser tabs */
.repo-tab__close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  opacity: 0.4;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  padding: 0;
}

.repo-tab:hover .repo-tab__close,
.repo-tab--active .repo-tab__close {
  opacity: 0.7;
}

.repo-tab__close:hover {
  opacity: 1 !important;
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.repo-tab-new-wrap {
  position: relative;
  display: inline-flex;
}

.repo-tab-new {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: var(--space-1);
  border-radius: var(--radius-pill);
  background: transparent;
  border: 0;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.repo-tab-new:hover,
.repo-tab-new--open {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

/* Dropdown menu — teleported to body, so position: fixed (top/left set
   inline from the trigger's bounding rect). Scoped CSS still applies via
   the data-v attribute that Vue keeps on the teleported root element. */
.repo-tab-new-menu {
  position: fixed;
  min-width: 240px;
  max-width: 320px;
  max-height: 360px;
  overflow-y: auto;
  padding: var(--space-2);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
}

.repo-tab-new-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm);
  background: transparent;
  border: 0;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.repo-tab-new-item:hover {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.repo-tab-new-item svg {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.repo-tab-new-item:hover svg {
  color: var(--color-accent);
}

/* ─── Pinned + Recent sections ──────────────────────────
   Two adjacent sub-sections, each with its own header. The
   `inner` separator visually splits pinned/recent when both
   exist, while the top-level separator splits actions from
   the history block. */
.repo-tab-new-separator {
  height: 1px;
  background: var(--color-border);
  margin: var(--space-2) 0;
}

.repo-tab-new-separator--inner {
  margin: var(--space-1) 0;
}

.repo-tab-new-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.repo-tab-new-section-label {
  padding: var(--space-1) var(--space-4);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

/* History entries show name + truncated path stacked vertically.
   `__text` is the flex column wrapper that owns the ellipsis on
   both lines — the parent .repo-tab-new-item provides the row
   layout (icon | text | optional pin star). */
.repo-tab-new-item--recent {
  align-items: center;
}

.repo-tab-new-item__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 1px;
}

.repo-tab-new-item__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-tab-new-item__path {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-tab-new-item--recent:hover .repo-tab-new-item__path {
  color: var(--color-accent);
  opacity: 0.8;
}

.repo-tab-new-item__pin {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-accent);
}
</style>
