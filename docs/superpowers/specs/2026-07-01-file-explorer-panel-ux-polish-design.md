# File Explorer panel — UX polish (v2)

Status: approved (brainstorming), ready for implementation plan.
Follow-up to: `docs/superpowers/specs/2026-07-01-file-explorer-editor-design.md` (v1, shipped on `feat/file-explorer-editor`).

## Problem

Real usage of the shipped v1 File Explorer/Editor panel surfaced four UX gaps:

1. **No drag/resize.** `FileExplorerPanel.vue` persists `left`/`top`/`width`/`height` refs to `localStorage` (mirroring `TerminalPanel.vue`'s storage keys), but never wires up the drag-to-move or resize-handle interactions that make those refs actually changeable by the user. This was a gap in the original implementation, not a deliberate simplification — the panel currently opens at a fixed size/position with no way to adjust it, and its header/tab-bar visual design is much sparser than `TerminalPanel.vue`'s (no fullscreen/hide buttons inline, no drag affordance).
2. **Tree fully expanded on open.** `useRepoFileTree`'s `collapsedFolders` starts empty, so every folder renders expanded — on a real repo this floods the tree with hundreds of rows instead of the flat top-level view a user expects to expand into.
3. **Cramped default position.** The panel opens as a small floating box (`left:16, top:80, width:640, height:360`) rather than the full-height, left-docked feel the user wants as a starting point (still adjustable afterward, since it stays in "floating" mode).
4. **No lock/undo/save controls in the panel itself.** Saving already works via `⌘S`, but there's no discoverable in-panel affordance for it, no visible "you can't edit this until you unlock it" safety rail, and no quick single-edit undo separate from full CodeMirror undo history.

## Goal

Bring the panel's interaction model up to parity with `TerminalPanel.vue` (drag, resize, matching header chrome) and add a deliberate edit-safety model: read-only by default, an explicit unlock step before typing, and a compact toolbar for the three actions a user reaches for most (lock/unlock, undo, save) — each with a visible text label, not icon-only.

## Non-goals

- No change to the tab-strip logic (preview/pinned tabs), the tree-fetch composable's data shape, or the CodeMirror language-detection/lazy-load mechanism — all of that ships as-is from v1.
- No per-tab lock state — the lock is a single global toggle for the whole panel (see below).
- No new keyboard shortcut for toggling lock (⌘S/⌘W/⌘1-9/CodeMirror's own ⌘Z already cover the fast paths; the toolbar covers discoverability).

## Design

### 1. Drag and resize — mirror `TerminalPanel.vue` exactly

Add the same interaction elements `TerminalPanel.vue` has, renamed to the `fe__` prefix, active only in floating mode (not bottom/fullscreen, matching the Terminal's own restriction):

- A drag handle on the tab bar (`fe__tabs`, `@mousedown="onMoveStart"`) — dragging the tab bar moves the panel.
- Resize handles on the left/right edges and all four corners (`fe__resize-x`, `fe__resize-x--left`, `fe__resize-y--bottom`, `fe__corner--tl/tr/bl/br`), each with its own `mousedown` handler following `TerminalPanel.vue`'s exact resize math (clamped to viewport, persisted to the same four `localStorage` keys already declared: `gitwand-explorer-{height,left,width,top}`).
- The header/tab-bar gets the same inline buttons `TerminalPanel.vue` has next to its tabs: fullscreen toggle and hide (close), using the same SVG icon set already used elsewhere in the app (stroke-based, `stroke="currentColor"`, no emoji — the visual-companion mockup's icons were wireframe placeholders only).

### 2. Default floating position/size

Floating-mode defaults change from the current small box to: `left: 0, top: 0, width: 380px, height: 100%` (100% of the panel's positioning container, `app-body`, which already sits below the app header — so `top: 0` lands directly under the header for free, matching the approved mockup). Still fully draggable/resizable afterward via (1) — this is a starting position, not a locked layout.

### 3. Tree collapsed by default

`useRepoFileTree`'s `isCollapsed(path)` flips its default: a folder is collapsed unless explicitly expanded, i.e. `collapsedFolders.value[path] ?? true` instead of `!!collapsedFolders.value[path]`. `toggleFolder` is unchanged — it still just flips whatever's in the map. Net effect: every folder starts closed; clicking one reveals its immediate children (which are themselves closed, per the same default, until clicked).

### 4. Bottom toolbar — lock, undo, save

A new `.fe__toolbar` row beneath the editor pane, present regardless of active tab (grayed out per-button when not applicable — e.g. no active tab, or a binary tab).

**State:** a single `editLocked` ref, default `true`, scoped to the whole panel (not per-tab) — switching tabs does not change the lock state, per explicit decision (simplicity over per-tab safety).

**Buttons**, each icon + visible text label (not icon-only), left-to-right: Lock/Unlock, Undo, spacer, Save.

- **Lock/Unlock** — toggles `editLocked`. Wired to CodeMirror via a new `Compartment` around `EditorView.editable.of(!editLocked)`. Because the lock is global but each tab has its own cached `EditorState`, the compartment's value is re-asserted (via `view.dispatch({ effects: ... })`) every time a tab is mounted or switched to, not just on toggle — this keeps a tab whose cached state predates the last lock toggle from momentarily showing the wrong editability. Toggling while unlocked never discards any pending edit; it only blocks *further* typing.
- **Undo** — calls `undo` from `@codemirror/commands` (new direct dependency; already present transitively via `codemirror`'s `basicSetup`, which is why `⌘Z` already works today — this button is a discoverable, mouse-driven path to the same command) against the active tab's view. Disabled when locked or when there's nothing to undo.
- **Save** — calls the existing `saveTab`. Disabled when the active tab isn't dirty or is binary. Not gated by `editLocked` — re-locking after an edit must not block saving that edit.

## Testing

- `useRepoFileTree` unit tests: update/add coverage for the collapsed-by-default behavior (`isCollapsed` returns `true` for a path never explicitly touched, `false` after one `toggleFolder` call, `true` again after a second).
- No new automated coverage is feasible for the drag/resize math or the CodeMirror lock/undo wiring (same testing gap `TerminalPanel.vue`'s own resize logic already has — no precedent to break). Verify manually via `pnpm dev:web` + browser interaction, mirroring how v1's CodeMirror integration was verified.
- Manual verification checklist: drag the panel by its tab bar, resize from each edge/corner, confirm bounds persist across a reload; open a repo and confirm the tree renders fully collapsed; toggle lock and confirm typing is blocked/allowed accordingly and the state survives a tab switch; click Undo after an edit and confirm it undoes exactly one CodeMirror history step; click Save and confirm it matches `⌘S`'s existing behavior.

## Follow-ups (not in this design)

- Per-tab lock state, if user feedback asks for it later.
- A visible "loading" state for a tab whose `readFile` hasn't resolved yet (tracked separately as a known v1 follow-up: the narrow edit-during-load-window data-loss risk documented in the v1 SDD ledger).
