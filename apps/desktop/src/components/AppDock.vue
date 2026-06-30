<script setup lang="ts">
/**
 * AppDock — floating navigation dock.
 *
 * Replaces the per-view tabs that used to live inside RepoSidebar and the
 * vertical Git Tree toggle strip. Each entry switches the main `viewMode`, so
 * every view can render full-bleed (no permanent left/right asides).
 *
 * Reads its layout from settings: entry visibility, order, icons-only, and a
 * free (drag-to-move) position. When unlocked, a grip handle appears on the
 * left — drag it to move the dock, right-click it for reset/lock actions.
 */
import { computed, ref, inject, nextTick, onBeforeUnmount } from "vue";
import type { ViewMode } from "../composables/useGitRepo";
import { useI18n } from "../composables/useI18n";
import { useSettings, normalizeDockOrder, isDockEntryHidden, type DockEntryId } from "../composables/useSettings";
import { OPEN_SETTINGS_KEY } from "../composables/branchPickerBridge";

const props = defineProps<{
  viewMode: ViewMode;
  /** Uncommitted-file count — shown as a badge on the Changes entry. */
  changesCount?: number;
  /** Open-PR count — shown as a badge on the PRs entry. */
  prCount?: number;
  /** Terminal panel currently open — drives the terminal tile's active state. */
  terminalActive?: boolean;
}>();

const emit = defineEmits<{
  changeView: [mode: ViewMode];
  toggleTerminal: [];
}>();

const { t } = useI18n();
const { settings, saveSettings } = useSettings();
const openSettings = inject(OPEN_SETTINGS_KEY, undefined);

/** Mutate the shared settings object and persist it (reactive everywhere). */
function patch(p: Partial<typeof settings.value>) {
  Object.assign(settings.value, p);
  saveSettings(settings.value);
}

// ─── Entry model ──────────────────────────────────────────

const iconsOnly = computed(() => settings.value.dockIconsOnly);
const vertical = computed(() => settings.value.dockVertical);
const idleOpacity = computed(() => settings.value.dockIdleOpacity ?? 0.45);

function isHidden(id: DockEntryId): boolean {
  return isDockEntryHidden(id, settings.value);
}

function entryLabel(id: DockEntryId): string {
  switch (id) {
    case "launchpad": return t("launchpad.title");
    case "dashboard": return t("sidebar.tabDashboard");
    case "prs": return "PRs";
    case "graph": return t("sidebar.gitTree");
    case "changes": return t("sidebar.tabChanges");
  }
}

/** Persisted order, normalised so all five entries are always present. */
const orderedIds = computed<DockEntryId[]>(() => normalizeDockOrder(settings.value.dockOrder));

/** Order, minus the entries the user has hidden. */
const visibleIds = computed<DockEntryId[]>(() => orderedIds.value.filter((id) => !isHidden(id)));

function isActive(id: DockEntryId): boolean {
  // History is a sub-view reached from the Git Tree (clicking a commit), so
  // it keeps the Git Tree entry highlighted.
  if (id === "graph") return props.viewMode === "graph" || props.viewMode === "history";
  return props.viewMode === id;
}

function badgeFor(id: DockEntryId): number | undefined {
  if (id === "prs") return props.prCount || undefined;
  if (id === "changes") return props.changesCount || undefined;
  return undefined;
}

// ─── Position / drag ──────────────────────────────────────

const dockEl = ref<HTMLElement | null>(null);
const unlocked = computed(() => settings.value.dockUnlocked);

/** Live position during an active drag (committed to settings on release). */
const livePos = ref<{ x: number; y: number } | null>(null);

/** No custom position set — the dock sits at its CSS default anchor. */
const atDefaultAnchor = computed(() => !(livePos.value ?? settings.value.dockPosition));

const dockStyle = computed(() => {
  const p = livePos.value ?? settings.value.dockPosition;
  if (p) {
    // Switch to viewport-fixed positioning so the stored x/y line up with the
    // getBoundingClientRect coords used during drag (no jump on grab).
    return { position: "fixed" as const, left: `${p.x}px`, top: `${p.y}px`, right: "auto", bottom: "auto", transform: "none" };
  }
  return {};
});

let startX = 0, startY = 0, originX = 0, originY = 0;

function clampPos(x: number, y: number): { x: number; y: number } {
  const w = dockEl.value?.offsetWidth ?? 0;
  const h = dockEl.value?.offsetHeight ?? 0;
  const maxX = Math.max(4, window.innerWidth - w - 4);
  const maxY = Math.max(4, window.innerHeight - h - 4);
  return { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) };
}

function startDrag(e: PointerEvent) {
  if (!unlocked.value || e.button !== 0) return;
  e.preventDefault();
  const rect = dockEl.value?.getBoundingClientRect();
  originX = rect?.left ?? 0;
  originY = rect?.top ?? 0;
  startX = e.clientX;
  startY = e.clientY;
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag);
}

function onDrag(e: PointerEvent) {
  livePos.value = clampPos(originX + (e.clientX - startX), originY + (e.clientY - startY));
}

function endDrag() {
  window.removeEventListener("pointermove", onDrag);
  window.removeEventListener("pointerup", endDrag);
  if (livePos.value) patch({ dockPosition: livePos.value });
  livePos.value = null;
}

// ─── Context menu (right-click on any entry or the handle) ─

/** target = the clicked entry, "terminal" for the terminal tile, or null when
 *  invoked from the global handle. */
type MenuTarget = DockEntryId | "terminal" | null;
const menu = ref<{ x: number; y: number; target: MenuTarget } | null>(null);

/** The menu's target as a dock entry (null for the terminal/global menus) —
 *  keeps the per-entry template block correctly typed as DockEntryId. */
const entryTarget = computed<DockEntryId | null>(() =>
  menu.value && menu.value.target !== "terminal" ? menu.value.target : null,
);
const menuEl = ref<HTMLElement | null>(null);

let menuListening = false;

function attachMenuListeners() {
  if (menuListening) return;
  window.addEventListener("pointerdown", onOutsideMenu, true);
  window.addEventListener("keydown", onMenuKey);
  menuListening = true;
}

function detachMenuListeners() {
  if (!menuListening) return;
  window.removeEventListener("pointerdown", onOutsideMenu, true);
  window.removeEventListener("keydown", onMenuKey);
  menuListening = false;
}

async function openMenu(e: MouseEvent, target: MenuTarget) {
  e.preventDefault();
  menu.value = { x: e.clientX, y: e.clientY, target };
  // The dock sits at the bottom of the screen, so a downward menu overflows.
  // Measure once rendered, then flip up / clamp into the viewport.
  await nextTick();
  const el = menuEl.value;
  if (el && menu.value) {
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + w > window.innerWidth - 4) x = window.innerWidth - w - 4;
    if (y + h > window.innerHeight - 4) y = e.clientY - h; // flip above the cursor
    menu.value = { ...menu.value, x: Math.max(4, x), y: Math.max(4, y) };
  }
  // Attach the outside-close listener only after this event cycle, otherwise the
  // opening right-click's own pointerdown immediately closes the menu — which
  // looked like "right-click does nothing" right after a position reset.
  setTimeout(attachMenuListeners, 0);
}

function closeMenu() {
  menu.value = null;
  detachMenuListeners();
}

function onOutsideMenu(e: PointerEvent) {
  if (!(e.target as HTMLElement)?.closest?.(".dock-menu")) closeMenu();
}

function onMenuKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeMenu();
}

/** Today / Dashboard / PRs can be removed; Git Tree & Changes cannot. */
function isRemovable(id: DockEntryId): boolean {
  return id === "launchpad" || id === "dashboard" || id === "prs";
}

function isStartup(id: DockEntryId): boolean {
  return settings.value.startupView === id;
}

/** Changes has no diff-less landing, so it is not offered as a startup view. */
function canBeStartup(id: DockEntryId): boolean {
  return id !== "changes";
}

// ── Per-target actions ──
function removeFromDock(id: DockEntryId) {
  if (id === "launchpad") patch({ dockHideLaunchpad: true });
  else if (id === "dashboard") patch({ dockHideDashboard: true });
  else if (id === "prs") patch({ dockHidePrs: true });
  closeMenu();
}

function setAsStartup(id: DockEntryId) {
  if (id === "changes") return; // not a valid startup view
  patch({ startupView: id });
  closeMenu();
}

// ── Global actions ──
function toggleLock() {
  patch({ dockUnlocked: !settings.value.dockUnlocked });
  closeMenu();
}

function toggleText() {
  patch({ dockIconsOnly: !settings.value.dockIconsOnly });
  closeMenu();
}

function toggleVertical() {
  patch({ dockVertical: !settings.value.dockVertical });
  closeMenu();
}

function resetPosition() {
  patch({ dockPosition: null });
  closeMenu();
}

function openDockSettings() {
  openSettings?.("dock");
  closeMenu();
}

// ── Terminal tile actions ──
const terminalHideOnNav = computed(() => settings.value.terminalHideOnNav);
const terminalIsFullscreen = computed(() => settings.value.terminalMode === "fullscreen");
/** Base layout (floating/bottom) — what fullscreen sits on top of. */
const terminalLayout = computed<"floating" | "bottom">(() =>
  terminalIsFullscreen.value ? settings.value.terminalPrevMode : (settings.value.terminalMode as "floating" | "bottom"),
);

/** Pick the base layout; also the layout fullscreen returns to. Exits fullscreen. */
function setTerminalLayout(m: "floating" | "bottom") {
  patch({ terminalMode: m, terminalPrevMode: m });
  closeMenu();
}

/** Fullscreen is an overlay on top of the base layout — toggle it on/off. */
function toggleTerminalFullscreen() {
  if (terminalIsFullscreen.value) {
    patch({ terminalMode: settings.value.terminalPrevMode });
  } else {
    patch({ terminalPrevMode: settings.value.terminalMode as "floating" | "bottom", terminalMode: "fullscreen" });
  }
  closeMenu();
}

function toggleTerminalHideOnNav() {
  patch({ terminalHideOnNav: !settings.value.terminalHideOnNav });
  closeMenu();
}

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onDrag);
  window.removeEventListener("pointerup", endDrag);
  closeMenu();
});
</script>

<template>
  <nav
    ref="dockEl"
    class="app-dock"
    :class="{ 'app-dock--unlocked': unlocked, 'app-dock--vertical': vertical, 'app-dock--vert-anchor': vertical && atDefaultAnchor }"
    :style="[dockStyle, { '--dock-idle-opacity': idleOpacity }]"
    :aria-label="t('sidebar.tabChanges')"
  >
    <div class="app-dock__pill" :class="{ 'app-dock__pill--icons-only': iconsOnly, 'app-dock__pill--vertical': vertical }">
      <!-- Drag handle — only when the dock is unlocked. -->
      <button
        v-if="unlocked"
        class="dock-handle"
        :title="t('settings.dock.handleTooltip')"
        :aria-label="t('settings.dock.handleTooltip')"
        @pointerdown="startDrag"
        @contextmenu="openMenu($event, null)"
      >
        <svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor" aria-hidden="true">
          <circle cx="4.5" cy="4" r="1.4" /><circle cx="9.5" cy="4" r="1.4" />
          <circle cx="4.5" cy="10" r="1.4" /><circle cx="9.5" cy="10" r="1.4" />
          <circle cx="4.5" cy="16" r="1.4" /><circle cx="9.5" cy="16" r="1.4" />
        </svg>
      </button>

      <template v-for="(id, i) in visibleIds" :key="id">
        <button
          class="dock-btn"
          :class="{ 'dock-btn--active': isActive(id) }"
          :aria-pressed="isActive(id)"
          :title="entryLabel(id)"
          @click="emit('changeView', id)"
          @contextmenu="openMenu($event, id)"
        >
          <!-- Today / Launchpad -->
          <svg v-if="id === 'launchpad'" class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 16.5c-1.5 1-2 4-2 4s3-.5 4-2c.6-.85.5-2 .5-2"/>
            <path d="M12 15l-3-3a11 11 0 0 1 7-9c2.5 0 4 1.5 4 4a11 11 0 0 1-9 7l1 1z"/>
            <path d="M9 12H5s.5-2.5 2-3.5c1.3-.85 3-.5 3-.5"/>
            <path d="M12 15v4s2.5-.5 3.5-2c.85-1.3.5-3 .5-3"/>
            <circle cx="15" cy="9" r="1.2"/>
          </svg>
          <!-- Dashboard -->
          <svg v-else-if="id === 'dashboard'" class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
          </svg>
          <!-- PRs -->
          <svg v-else-if="id === 'prs'" class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
          </svg>
          <!-- Git Tree -->
          <svg v-else-if="id === 'graph'" class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="12" r="3" /><path d="M6 9v6" /><path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <!-- Changes -->
          <svg v-else class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
          </svg>

          <span class="dock-label">{{ entryLabel(id) }}</span>
          <span v-if="badgeFor(id)" class="dock-badge">{{ badgeFor(id) }}</span>
        </button>

        <!-- Keep the cross-repo / per-repo divider right after Today. -->
        <span v-if="id === 'launchpad' && i < visibleIds.length - 1" class="dock-sep" aria-hidden="true"></span>
      </template>
    </div>

    <!-- Terminal tile — a separate rounded square that rides along with the
         dock (same position/lock), opening the floating terminal panel. -->
    <button
      class="dock-terminal"
      :class="{ 'dock-terminal--active': terminalActive }"
      :aria-pressed="terminalActive"
      :title="t('terminal.headerTooltip')"
      :aria-label="t('terminal.headerLabel')"
      @click="emit('toggleTerminal')"
      @contextmenu="openMenu($event, 'terminal')"
    >
      <svg class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4 17 10 11 4 5"/>
        <line x1="12" y1="19" x2="20" y2="19"/>
      </svg>
    </button>

    <!-- Right-click context menu (entry-targeted + global actions).
         Teleported to <body> so its fixed positioning is relative to the
         viewport — the dock's own translateX(-50%) transform would otherwise
         become the containing block and push the menu off-screen. -->
    <Teleport to="body">
    <div v-if="menu" ref="menuEl" class="dock-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu">
      <!-- Terminal tile section -->
      <template v-if="menu.target === 'terminal'">
        <div class="dock-menu-label">{{ t('terminal.headerLabel') }}</div>
        <button class="dock-menu-item" role="menuitemcheckbox"
          :aria-checked="terminalHideOnNav" @click="toggleTerminalHideOnNav">
          {{ t('terminal.menuHideOnNav') }}
          <span class="dock-menu-check">{{ terminalHideOnNav ? '✓' : '' }}</span>
        </button>
        <button class="dock-menu-item" role="menuitemcheckbox"
          :aria-checked="terminalIsFullscreen" @click="toggleTerminalFullscreen">
          {{ t('terminal.modeFullscreen') }}
          <span class="dock-menu-check">{{ terminalIsFullscreen ? '✓' : '' }}</span>
        </button>
        <div class="dock-menu-sep" role="separator"></div>
        <div class="dock-menu-label">{{ t('terminal.menuLayout') }}</div>
        <button class="dock-menu-item" role="menuitemradio"
          :aria-checked="terminalLayout === 'floating'" @click="setTerminalLayout('floating')">
          {{ t('terminal.modeFloating') }}
          <span class="dock-menu-check">{{ terminalLayout === 'floating' ? '✓' : '' }}</span>
        </button>
        <button class="dock-menu-item" role="menuitemradio"
          :aria-checked="terminalLayout === 'bottom'" @click="setTerminalLayout('bottom')">
          {{ t('terminal.modeBottom') }}
          <span class="dock-menu-check">{{ terminalLayout === 'bottom' ? '✓' : '' }}</span>
        </button>
      </template>

      <template v-else>
      <!-- Per-target section -->
      <template v-if="entryTarget">
        <div class="dock-menu-label">{{ entryLabel(entryTarget) }}</div>
        <button v-if="isRemovable(entryTarget)" class="dock-menu-item" role="menuitem"
          @click="removeFromDock(entryTarget)">
          {{ t('settings.dock.menu.remove') }}
        </button>
        <button v-if="canBeStartup(entryTarget)" class="dock-menu-item" role="menuitemcheckbox"
          :aria-checked="isStartup(entryTarget)" @click="setAsStartup(entryTarget)">
          {{ t('settings.dock.menu.setStartup') }}
          <span class="dock-menu-check">{{ isStartup(entryTarget) ? '✓' : '' }}</span>
        </button>
        <div class="dock-menu-sep" role="separator"></div>
      </template>

      <!-- Global section -->
      <button class="dock-menu-item" role="menuitem" @click="toggleLock">
        {{ unlocked ? t('settings.dock.menu.lock') : t('settings.dock.menu.unlock') }}
      </button>
      <button v-if="!vertical" class="dock-menu-item" role="menuitem" @click="toggleText">
        {{ iconsOnly ? t('settings.dock.menu.showText') : t('settings.dock.menu.hideText') }}
      </button>
      <button class="dock-menu-item" role="menuitem" @click="toggleVertical">
        {{ vertical ? t('settings.dock.menu.horizontal') : t('settings.dock.menu.vertical') }}
      </button>
      <button class="dock-menu-item" role="menuitem" :disabled="!settings.dockPosition" @click="resetPosition">
        {{ t('settings.dock.resetPosition') }}
      </button>
      <button class="dock-menu-item" role="menuitem" @click="openDockSettings">
        {{ t('settings.dock.menu.openSettings') }}
      </button>
      </template>
    </div>
    </Teleport>
  </nav>
</template>

<style scoped>
.app-dock {
  position: absolute;
  bottom: var(--space-4, 12px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  pointer-events: none;
  display: flex;
  align-items: stretch;
  gap: var(--space-2, 6px);
}

/* Vertical dock → stack the terminal tile under the pill. */
.app-dock--vertical {
  flex-direction: column;
  align-items: stretch;
}

/* Vertical dock with no custom position → anchor to the center-left edge. */
.app-dock--vert-anchor {
  left: var(--space-4, 12px);
  bottom: auto;
  top: 50%;
  transform: translateY(-50%);
}

.app-dock__pill {
  pointer-events: auto;
  display: flex;
  align-items: stretch;
  gap: var(--space-1, 4px);
  padding: var(--space-2, 6px);
  background: color-mix(in srgb, var(--color-bg-secondary) 97%, transparent);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(8px);
  opacity: var(--dock-idle-opacity, 0.45);
  transition: opacity 0.2s ease;
}

.app-dock__pill:hover,
.app-dock:hover .app-dock__pill {
  opacity: 1;
}

/* Terminal tile — mirrors the pill's chrome but as a standalone square that
   sits flush beside the dock and shares its idle-fade behaviour. */
.dock-terminal {
  pointer-events: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5, 9px);
  background: color-mix(in srgb, var(--color-bg-secondary) 97%, transparent);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(8px);
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: var(--dock-idle-opacity, 0.45);
  transition: opacity 0.2s ease, background 0.15s, color 0.15s;
}

.app-dock:hover .dock-terminal {
  opacity: 1;
}

.dock-terminal:hover {
  color: var(--color-text);
  background: var(--color-bg-secondary);
}

.dock-terminal--active {
  color: var(--color-accent);
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
}

.dock-terminal:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.dock-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-1, 4px);
  border: none;
  border-radius: var(--radius-sm, 8px);
  background: transparent;
  color: var(--color-text-muted);
  cursor: grab;
  touch-action: none;
}

.dock-handle:hover {
  background: var(--color-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--color-text);
}

.dock-handle:active {
  cursor: grabbing;
}

.dock-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: var(--space-3, 9px) var(--space-5, 18px);
  border: none;
  border-radius: var(--radius-sm, 8px);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-md, 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}

.dock-btn:hover {
  background: var(--color-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--color-text);
}

.dock-btn--active {
  background: var(--color-accent-soft, rgba(139, 92, 246, 0.16));
  color: var(--color-accent);
}

.dock-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.dock-sep {
  flex-shrink: 0;
  align-self: stretch;
  width: 1px;
  margin: var(--space-1, 4px) var(--space-1, 4px);
  background: var(--color-border);
}

.dock-icon {
  flex-shrink: 0;
}

.dock-label {
  line-height: 1;
}

/* Icons-only mode — hide labels, tighten the buttons to square icon tiles. */
.app-dock__pill--icons-only .dock-label {
  display: none;
}

.app-dock__pill--icons-only .dock-btn {
  padding: var(--space-3, 9px);
}

/* Vertical mode — stack the dock as a column; rotate icon + text 90°. */
.app-dock__pill--vertical {
  flex-direction: column;
}

.app-dock__pill--vertical .dock-handle {
  padding: var(--space-1, 4px) 0;
}

.app-dock__pill--vertical .dock-handle svg {
  transform: rotate(90deg);
}

.app-dock__pill--vertical .dock-btn {
  flex-direction: column;
  gap: var(--space-3, 9px);
  padding: var(--space-3, 9px);
}

/* Vertical dock is icon-only; keep the glyphs upright. */
.app-dock__pill--vertical .dock-label {
  display: none;
}

.app-dock__pill--vertical .dock-icon {
  transform: none;
}

.app-dock__pill--vertical .dock-sep {
  align-self: stretch;
  width: auto;
  height: 1px;
  margin: var(--space-1, 4px) var(--space-1, 4px);
}

.dock-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--color-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 0;
}

/* Handle right-click menu. */
.dock-menu {
  position: fixed;
  z-index: 60;
  pointer-events: auto;
  min-width: 160px;
  padding: var(--space-1, 4px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.18);
}

.dock-menu-label {
  padding: var(--space-1, 4px) var(--space-3, 9px) var(--space-2, 6px);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.dock-menu-sep {
  height: 1px;
  margin: var(--space-1, 4px) 0;
  background: var(--color-border);
}

.dock-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2, 6px);
  width: 100%;
  padding: var(--space-2, 6px) var(--space-3, 9px);
  border: none;
  border-radius: var(--radius-sm, 8px);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-md, 14px);
  text-align: left;
  cursor: pointer;
}

.dock-menu-check {
  display: inline-block;
  width: 12px;
  flex-shrink: 0;
  margin-left: auto;
  text-align: right;
  color: var(--color-accent);
}

.dock-menu-item:hover:not(:disabled) {
  background: var(--color-bg-hover, rgba(127, 127, 127, 0.12));
}

.dock-menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
