# File Explorer Panel UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `FileExplorerPanel.vue`'s interaction model up to parity with `TerminalPanel.vue` (drag-to-move, resize handles, matching header chrome) and add a deliberate edit-safety model: tree collapsed by default, a full-height left-docked starting position, and a labeled bottom toolbar (lock/unlock, undo, save).

**Architecture:** Drag/resize logic is extracted from `TerminalPanel.vue` into a new shared composable, `useDraggableResizable.ts` (per pre-flight design review — avoids duplicating ~200 lines of mouse-event math between the two panels), which both `TerminalPanel.vue` (refactored, zero behavior change) and `FileExplorerPanel.vue` (new usage) consume. `FileExplorerPanel.vue` also gains a draggable header with a fullscreen button and a new bottom toolbar wired to a new CodeMirror `Compartment` for the editable state. Plus a one-line semantic flip in `useRepoFileTree.ts` and new i18n keys across 5 locales. No backend/Rust changes.

**Tech Stack:** Vue 3 `<script setup>`, CodeMirror 6 (`@codemirror/commands` added as a new direct dependency; `Compartment` from the already-installed `@codemirror/state`).

Design doc: `docs/superpowers/specs/2026-07-01-file-explorer-panel-ux-polish-design.md`.

## Global Constraints

- This is a follow-up to the already-shipped v1 File Explorer feature on branch `feat/file-explorer-editor` — all v1 files already exist as described in this plan's "current state" quotes. Do not re-create anything; only modify.
- Drag/resize math is extracted into a shared `useDraggableResizable` composable (Task 3) rather than duplicated — same clamping, same localStorage persistence pattern as the original `TerminalPanel.vue` code, byte-faithful, not a reinvention. Every mutable drag/resize variable must live inside the composable function's closure, never at module scope — `TerminalPanel.vue` and `FileExplorerPanel.vue` can both be open at once, and module-scope state would leak between the two panels' independent drag operations.
- `TerminalPanel.vue`'s existing localStorage keys (`gitwand-terminal-{height,left,width,top}`) and exact behavior (drag/resize math, the `bottom`-mode move lock, the rename-input/dropdown move-ignore exclusions) must not change as an observable side effect of the Task 3 refactor — existing users' saved terminal size/position and interaction behavior must be preserved exactly.
- The lock/unlock state is global to the panel, not per-tab (explicit user decision) — do not add per-tab lock state.
- Toolbar buttons must show an icon **and** a visible text label — no icon-only buttons (explicit user correction during design review).
- No native `confirm()`/`alert()` — N/A for this plan (no new confirmation dialogs).
- Every user-visible string needs a key in all 5 locales: `en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`.
- `apps/desktop/src/CLAUDE.md`: `<script setup>` only, no direct `invoke()` outside `backend.ts` (N/A here, no new Tauri calls).
- `apps/desktop/CLAUDE.md` performance rule: CodeMirror stays lazy-loaded — `@codemirror/commands`'s `undo`/`undoDepth` must be added to the existing dynamic-import batch in `ensureCodeMirrorLibs()`, not statically imported at module scope.

---

### Task 1: Tree collapsed by default

**Files:**
- Modify: `apps/desktop/src/composables/useRepoFileTree.ts:36-38`
- Modify: `apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts`

**Interfaces:**
- No signature changes — `isCollapsed(path: string): boolean` and `toggleFolder(path: string): void` keep the same shapes; `isCollapsed`'s default return value flips, and `toggleFolder` must negate the *effective* (post-default) state rather than the raw stored flag — see Step 3, this is not optional: negating only the raw flag makes the first toggle on any untouched folder a no-op (`!undefined` is `true`, which `isCollapsed`'s new `?? true` default still reads as collapsed).

**Current code** (`useRepoFileTree.ts:32-38`):

```typescript
  function toggleFolder(path: string) {
    collapsedFolders.value[path] = !collapsedFolders.value[path];
  }

  function isCollapsed(path: string): boolean {
    return !!collapsedFolders.value[path];
  }
```

- [ ] **Step 1: Update the existing tests to the new default (write the failing test first)**

The current test file has two tests that assume folders start *expanded*. Replace them with three tests reflecting the new collapsed-by-default behavior. Open `apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts` and replace this block:

```typescript
  it("flattens the fetched tree into rows and rolls up folder counts", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);

    await tree.refresh();

    expect(listRepoTree).toHaveBeenCalledWith("/repo");
    expect(tree.rows.value.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "src", 0],
      ["file", "src/main.ts", 1],
      ["file", "src/util.ts", 1],
      ["file", "README.md", 0],
    ]);
    expect(tree.rows.value[0].count).toBe(2);
  });

  it("collapsing a folder hides its descendants", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    tree.toggleFolder("src");
    expect(tree.isCollapsed("src")).toBe(true);
    expect(tree.rows.value.map((r) => r.path)).toEqual(["src", "README.md"]);
  });
```

with:

```typescript
  it("all folders are collapsed by default and rolls up folder counts", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);

    await tree.refresh();

    expect(listRepoTree).toHaveBeenCalledWith("/repo");
    expect(tree.isCollapsed("src")).toBe(true);
    expect(tree.rows.value.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "src", 0],
      ["file", "README.md", 0],
    ]);
    expect(tree.rows.value[0].count).toBe(2);
  });

  it("toggling a collapsed folder reveals its descendants", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    tree.toggleFolder("src");

    expect(tree.isCollapsed("src")).toBe(false);
    expect(tree.rows.value.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "src", 0],
      ["file", "src/main.ts", 1],
      ["file", "src/util.ts", 1],
      ["file", "README.md", 0],
    ]);
  });

  it("toggling an expanded folder collapses it again", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    tree.toggleFolder("src"); // expand
    tree.toggleFolder("src"); // collapse again

    expect(tree.isCollapsed("src")).toBe(true);
    expect(tree.rows.value.map((r) => r.path)).toEqual(["src", "README.md"]);
  });
```

Leave the third existing test (`"exposes a status lookup keyed by path"`) untouched — it doesn't depend on collapse state.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useRepoFileTree.test.ts`
Expected: FAIL — `"all folders are collapsed by default..."` and `"toggling a collapsed folder reveals..."` fail because `isCollapsed` still defaults to `false` (expanded).

- [ ] **Step 3: Flip the default, and fix `toggleFolder` to negate the effective state**

In `apps/desktop/src/composables/useRepoFileTree.ts`, change:

```typescript
  function toggleFolder(path: string) {
    collapsedFolders.value[path] = !collapsedFolders.value[path];
  }

  function isCollapsed(path: string): boolean {
    return !!collapsedFolders.value[path];
  }
```

to:

```typescript
  function toggleFolder(path: string) {
    // Negate the *effective* state (via isCollapsed), not the raw stored
    // flag — collapsedFolders only ever holds explicit overrides, so an
    // untouched path is `undefined`. Negating `undefined` directly would
    // always produce `true`, making the very first toggle on any
    // never-touched folder a no-op once isCollapsed defaults missing
    // entries to collapsed (`true`).
    collapsedFolders.value[path] = !isCollapsed(path);
  }

  function isCollapsed(path: string): boolean {
    return collapsedFolders.value[path] ?? true;
  }
```

Note `toggleFolder` now calls `isCollapsed`, so `isCollapsed` must be defined (or at least hoisted) before `toggleFolder` runs — function declarations are hoisted within the same scope in JavaScript, so keeping both as `function` declarations (not `const ... = () =>`) in either order works; just don't convert either to an arrow-function `const` without also reordering them so `isCollapsed` is declared first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useRepoFileTree.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useRepoFileTree.ts apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts
git commit -m "fix(desktop): collapse File Explorer tree folders by default"
```

---

### Task 2: i18n — toolbar labels in all 5 locales

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/fr.ts`
- Modify: `apps/desktop/src/locales/es.ts`
- Modify: `apps/desktop/src/locales/pt-BR.ts`
- Modify: `apps/desktop/src/locales/zh-CN.ts`

**Interfaces:**
- Produces: `files.toolbarEdit`, `files.toolbarLock`, `files.toolbarUndo`, `files.toolbarSave`, `files.fullscreen`, `files.exitFullscreen` — `fullscreen`/`exitFullscreen` consumed by Task 5 (header), the four `toolbar*` keys consumed by Task 6 (toolbar).

The current `files: { ... }` block ends with `discardChanges: "Discard changes",` (or its translation) right before the closing `},` in each locale file. Add the new keys immediately before that closing `},` (i.e. right after `discardChanges`/its translation) in each file.

- [ ] **Step 1: Add to `en.ts`**

Current block ends (`apps/desktop/src/locales/en.ts:2304-2307`):

```typescript
    unsavedMessage: "\"{0}\" has unsaved changes. Discard them?",
    discardChanges: "Discard changes",
  },
```

Change to:

```typescript
    unsavedMessage: "\"{0}\" has unsaved changes. Discard them?",
    discardChanges: "Discard changes",
    toolbarEdit: "Edit",
    toolbarLock: "Lock",
    toolbarUndo: "Undo",
    toolbarSave: "Save",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
  },
```

- [ ] **Step 2: Add to `fr.ts`**

Find `fr.ts`'s `files: { ... }` block (same key set, translated values, ending with its own `discardChanges` line) and add, in the same position:

```typescript
    toolbarEdit: "Modifier",
    toolbarLock: "Verrouiller",
    toolbarUndo: "Annuler",
    toolbarSave: "Enregistrer",
    fullscreen: "Plein écran",
    exitFullscreen: "Quitter le plein écran",
```

- [ ] **Step 3: Add to `es.ts`**

Same position, translated:

```typescript
    toolbarEdit: "Editar",
    toolbarLock: "Bloquear",
    toolbarUndo: "Deshacer",
    toolbarSave: "Guardar",
    fullscreen: "Pantalla completa",
    exitFullscreen: "Salir de pantalla completa",
```

- [ ] **Step 4: Add to `pt-BR.ts`**

Same position, translated:

```typescript
    toolbarEdit: "Editar",
    toolbarLock: "Bloquear",
    toolbarUndo: "Desfazer",
    toolbarSave: "Salvar",
    fullscreen: "Tela cheia",
    exitFullscreen: "Sair da tela cheia",
```

- [ ] **Step 5: Add to `zh-CN.ts`**

Same position, translated:

```typescript
    toolbarEdit: "编辑",
    toolbarLock: "锁定",
    toolbarUndo: "撤销",
    toolbarSave: "保存",
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
```

- [ ] **Step 6: Verify locale key parity**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no errors — the `Widen<T>` type machinery in `en.ts` fails to compile if any of the other 4 locales is missing a key `en.ts` has, so a clean type-check proves all 5 files match.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): add File Explorer toolbar/fullscreen i18n keys"
```

---

### Task 3: Extract `useDraggableResizable` composable, refactor `TerminalPanel.vue` to use it

**Files:**
- Create: `apps/desktop/src/composables/useDraggableResizable.ts`
- Modify: `apps/desktop/src/components/TerminalPanel.vue`

**Interfaces:**
- Produces: `useDraggableResizable(options: DraggableResizableOptions)` returning `{ height, left, top, width, isDragging, isResizingX, isResizingL, isResizingBottom, resizingCorner, onDragStart, onMoveStart, onResizeXStart, onResizeLeftStart, onResizeBottomStart, onResizeCornerStart }` — consumed by this task's `TerminalPanel.vue` refactor and by Task 4's `FileExplorerPanel.vue` wiring.
- `DraggableResizableOptions`: `{ panelRef: Ref<HTMLElement | null>; keyPrefix: string; initialHeight: number; initialLeft: number; initialWidth: number; initialTop: number; canMove?: () => boolean; moveIgnoreSelector?: string; minWidth?: number; minHeight?: number }`.

Per the pre-flight design review, the drag/resize logic is extracted into a shared composable instead of being duplicated between `TerminalPanel.vue` and `FileExplorerPanel.vue` — both panels can be open simultaneously, so **all mutable drag-tracking state must live inside the composable function's closure, not at module scope** (the original `TerminalPanel.vue` code used module-level `let` variables, which was safe there because only one `TerminalPanel` instance ever mounts at once; a shared composable called from two simultaneously-mounted panels would have those variables collide if left at module scope — this is the one behavioral risk in this refactor, and the reason for the explicit test in Step 4).

- [ ] **Step 1: Create the composable**

Create `apps/desktop/src/composables/useDraggableResizable.ts`:

```typescript
import { ref, type Ref } from "vue";

export type Corner = "tl" | "tr" | "bl" | "br";

export interface DraggableResizableOptions {
  /** Template ref to the panel's root element — read for its own and its
   * parent container's current dimensions when a drag/resize starts. */
  panelRef: Ref<HTMLElement | null>;
  /** localStorage key prefix — persisted keys are `${keyPrefix}-{height,left,width,top}`. */
  keyPrefix: string;
  /** Initial values, owned by the caller (read once from localStorage with
   * whatever fallback/sentinel convention that panel uses). */
  initialHeight: number;
  initialLeft: number;
  initialWidth: number;
  initialTop: number;
  /** Called before a move-drag starts; return false to block it (e.g. a
   * "bottom" docked mode can't be moved). Defaults to always allowed. */
  canMove?: () => boolean;
  /** mousedown targets matching this selector never start a move-drag, so
   * clicking an interactive element inside the drag handle doesn't also
   * move the panel. Defaults to "button". */
  moveIgnoreSelector?: string;
  minWidth?: number; // default 300
  minHeight?: number; // default 120
}

/**
 * Drag-to-move (both axes) + 6 resize affordances (top edge, left edge,
 * right edge, bottom edge, 4 corners) for a floating panel, with
 * localStorage persistence. Extracted from TerminalPanel.vue so
 * FileExplorerPanel.vue doesn't duplicate the same ~200 lines of mouse-event
 * math — every mutable variable below is local to one call's closure, so
 * two simultaneously-mounted panels each calling this composable get fully
 * independent drag state.
 */
export function useDraggableResizable(options: DraggableResizableOptions) {
  const {
    panelRef,
    keyPrefix,
    initialHeight,
    initialLeft,
    initialWidth,
    initialTop,
    canMove = () => true,
    moveIgnoreSelector = "button",
    minWidth = 300,
    minHeight = 120,
  } = options;

  const HEIGHT_KEY = `${keyPrefix}-height`;
  const LEFT_KEY = `${keyPrefix}-left`;
  const WIDTH_KEY = `${keyPrefix}-width`;
  const TOP_KEY = `${keyPrefix}-top`;

  const height = ref(initialHeight);
  const left = ref(initialLeft);
  const width = ref(initialWidth);
  const top = ref(initialTop);

  // ── Drag-to-resize (top edge) — grows the panel upward, bottom edge fixed ──
  let dragStartY = 0;
  let dragStartH = 0;
  let dragStartTop = 0;
  const isDragging = ref(false);
  function onDragStart(e: MouseEvent) {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartH = height.value;
    dragStartTop = top.value;
    isDragging.value = true;
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onDragMove, { passive: false });
    window.addEventListener("mouseup", onDragEnd);
  }
  function onDragMove(e: MouseEvent) {
    e.preventDefault();
    height.value = Math.max(minHeight, dragStartH + (dragStartY - e.clientY));
    top.value = Math.max(0, dragStartTop - (height.value - dragStartH));
  }
  function onDragEnd() {
    localStorage.setItem(HEIGHT_KEY, String(height.value));
    localStorage.setItem(TOP_KEY, String(top.value));
    isDragging.value = false;
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }

  // ── Drag-to-move (header/tab bar) — both axes ──
  let moveStartX = 0;
  let moveStartY = 0;
  let moveStartLeft = 0;
  let moveStartTop = 0;
  let moveBoundW = 0;
  let moveBoundH = 0;
  let movePanelW = 0;
  let movePanelH = 0;
  let isMoving = false;
  function onMoveStart(e: MouseEvent) {
    if (!canMove()) return;
    if ((e.target as HTMLElement).closest(moveIgnoreSelector)) return;
    e.preventDefault();
    moveStartX = e.clientX;
    moveStartY = e.clientY;
    moveStartLeft = left.value;
    moveStartTop = top.value;
    moveBoundW = panelRef.value?.parentElement?.offsetWidth ?? window.innerWidth;
    moveBoundH = panelRef.value?.parentElement?.offsetHeight ?? window.innerHeight;
    movePanelW = panelRef.value?.offsetWidth ?? width.value;
    movePanelH = panelRef.value?.offsetHeight ?? height.value;
    isMoving = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    window.addEventListener("mousemove", onMoveMove, { passive: false });
    window.addEventListener("mouseup", onMoveEnd);
  }
  function onMoveMove(e: MouseEvent) {
    if (!isMoving) return;
    e.preventDefault();
    left.value = Math.max(0, Math.min(moveBoundW - movePanelW, moveStartLeft + (e.clientX - moveStartX)));
    top.value = Math.max(0, Math.min(moveBoundH - movePanelH, moveStartTop + (e.clientY - moveStartY)));
  }
  function onMoveEnd() {
    localStorage.setItem(LEFT_KEY, String(left.value));
    localStorage.setItem(TOP_KEY, String(top.value));
    isMoving = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMoveMove);
    window.removeEventListener("mouseup", onMoveEnd);
  }

  // ── Right-edge resize ──
  let resizeXStartX = 0;
  let resizeXStartW = 0;
  let resizeXBoundW = 0;
  const isResizingX = ref(false);
  function onResizeXStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeXStartX = e.clientX;
    resizeXStartW = panelRef.value?.offsetWidth ?? width.value;
    resizeXBoundW = panelRef.value?.parentElement?.offsetWidth ?? window.innerWidth;
    isResizingX.value = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onResizeXMove, { passive: false });
    window.addEventListener("mouseup", onResizeXEnd);
  }
  function onResizeXMove(e: MouseEvent) {
    if (!isResizingX.value) return;
    e.preventDefault();
    const newW = resizeXStartW + (e.clientX - resizeXStartX);
    width.value = Math.max(minWidth, Math.min(resizeXBoundW - left.value, newW));
  }
  function onResizeXEnd() {
    localStorage.setItem(WIDTH_KEY, String(width.value));
    isResizingX.value = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onResizeXMove);
    window.removeEventListener("mouseup", onResizeXEnd);
  }

  // ── Left-edge resize (right edge stays fixed) ──
  let resizeLStartX = 0;
  let resizeLStartW = 0;
  let resizeLStartLeft = 0;
  const isResizingL = ref(false);
  function onResizeLeftStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeLStartX = e.clientX;
    resizeLStartW = panelRef.value?.offsetWidth ?? width.value;
    resizeLStartLeft = left.value;
    isResizingL.value = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onResizeLeftMove, { passive: false });
    window.addEventListener("mouseup", onResizeLeftEnd);
  }
  function onResizeLeftMove(e: MouseEvent) {
    if (!isResizingL.value) return;
    e.preventDefault();
    const delta = e.clientX - resizeLStartX;
    const rightEdge = resizeLStartLeft + resizeLStartW;
    const newLeft = Math.max(0, Math.min(rightEdge - minWidth, resizeLStartLeft + delta));
    left.value = newLeft;
    width.value = rightEdge - newLeft;
  }
  function onResizeLeftEnd() {
    localStorage.setItem(WIDTH_KEY, String(width.value));
    localStorage.setItem(LEFT_KEY, String(left.value));
    isResizingL.value = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onResizeLeftMove);
    window.removeEventListener("mouseup", onResizeLeftEnd);
  }

  // ── Bottom-edge resize (top stays fixed) ──
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
    window.addEventListener("mouseup", onResizeBottomEnd);
  }
  function onResizeBottomMove(e: MouseEvent) {
    if (!isResizingBottom.value) return;
    e.preventDefault();
    height.value = Math.max(minHeight, bottomStartH + (e.clientY - bottomStartY));
  }
  function onResizeBottomEnd() {
    localStorage.setItem(HEIGHT_KEY, String(height.value));
    isResizingBottom.value = false;
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onResizeBottomMove);
    window.removeEventListener("mouseup", onResizeBottomEnd);
  }

  // ── Corner resize (combines an X edge + the Y edge on that corner) ──
  const resizingCorner = ref<Corner | null>(null);
  let cornerStartX = 0, cornerStartY = 0, cornerStartW = 0, cornerStartH = 0, cornerStartLeft = 0, cornerStartTop = 0, cornerBoundW = 0;
  function onResizeCornerStart(corner: Corner, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    cornerStartX = e.clientX;
    cornerStartY = e.clientY;
    cornerStartW = panelRef.value?.offsetWidth ?? width.value;
    cornerStartH = height.value;
    cornerStartLeft = left.value;
    cornerStartTop = top.value;
    cornerBoundW = panelRef.value?.parentElement?.offsetWidth ?? window.innerWidth;
    resizingCorner.value = corner;
    document.body.style.userSelect = "none";
    document.body.style.cursor = corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
    window.addEventListener("mousemove", onResizeCornerMove, { passive: false });
    window.addEventListener("mouseup", onResizeCornerEnd);
  }
  function onResizeCornerMove(e: MouseEvent) {
    const corner = resizingCorner.value;
    if (!corner) return;
    e.preventDefault();
    const dx = e.clientX - cornerStartX;
    const dy = e.clientY - cornerStartY;
    if (corner === "tl" || corner === "tr") {
      height.value = Math.max(minHeight, cornerStartH - dy);
      top.value = Math.max(0, cornerStartTop + (cornerStartH - height.value));
    } else {
      height.value = Math.max(minHeight, cornerStartH + dy);
    }
    if (corner === "tr" || corner === "br") {
      width.value = Math.max(minWidth, Math.min(cornerBoundW - left.value, cornerStartW + dx));
    } else {
      const rightEdge = cornerStartLeft + cornerStartW;
      const newLeft = Math.max(0, Math.min(rightEdge - minWidth, cornerStartLeft + dx));
      left.value = newLeft;
      width.value = rightEdge - newLeft;
    }
  }
  function onResizeCornerEnd() {
    localStorage.setItem(HEIGHT_KEY, String(height.value));
    localStorage.setItem(WIDTH_KEY, String(width.value));
    localStorage.setItem(LEFT_KEY, String(left.value));
    localStorage.setItem(TOP_KEY, String(top.value));
    resizingCorner.value = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onResizeCornerMove);
    window.removeEventListener("mouseup", onResizeCornerEnd);
  }

  return {
    height, left, width, top,
    isDragging, isResizingX, isResizingL, isResizingBottom, resizingCorner,
    onDragStart, onMoveStart, onResizeXStart, onResizeLeftStart, onResizeBottomStart, onResizeCornerStart,
  };
}
```

- [ ] **Step 2: Refactor `TerminalPanel.vue` to use it**

In `apps/desktop/src/components/TerminalPanel.vue`, add the import at the top (near the other composable imports):

```typescript
import { useDraggableResizable } from "../composables/useDraggableResizable";
```

Replace this block (currently lines 140-150):

```typescript
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
```

with just:

```typescript
const tpRef = ref<HTMLElement | null>(null);
```

Then, right after the existing `toggleFullscreen` function (which itself stays unchanged, right after `const bottom = computed(() => mode.value === "bottom");`), insert:

```typescript
const {
  height, left, width, top,
  isDragging, isResizingX, isResizingL, isResizingBottom, resizingCorner,
  onDragStart, onMoveStart, onResizeXStart, onResizeLeftStart, onResizeBottomStart, onResizeCornerStart,
} = useDraggableResizable({
  panelRef: tpRef,
  keyPrefix: "gitwand-terminal",
  initialHeight: Number(localStorage.getItem("gitwand-terminal-height")) || 260,
  initialLeft: Number(localStorage.getItem("gitwand-terminal-left")) || 16,
  initialWidth: Number(localStorage.getItem("gitwand-terminal-width")) || 0, // 0 = not yet set; initialised on mount
  initialTop: Number(localStorage.getItem("gitwand-terminal-top")) || 0, // 0 = not yet set; initialised on mount
  canMove: () => !bottom.value,
  moveIgnoreSelector: "button, .tp__tab, .tp__rename, .tp__menu",
});
```

This must land *after* `bottom` is declared (the `canMove` closure reads `bottom.value`) and *before* the existing `onMounted(() => { ... })` block that reads `width.value`/`top.value` to auto-fill them on first mount — that `onMounted` block itself is unchanged, it just now reads/writes the composable's refs instead of locally-declared ones.

Finally, delete the entire old inline block of drag/resize functions — everything from the `// Drag-to-resize (top edge)` comment (originally around line 505) through the end of `onResizeCornerEnd` (originally around line 736, right before the `<template>` section starts). All of it is now provided by the composable call above; the template's existing bindings (`onDragStart`, `isDragging`, `onMoveStart`, `onResizeLeftStart`, `isResizingL`, `onResizeXStart`, `isResizingX`, `onResizeBottomStart`, `isResizingBottom`, `onResizeCornerStart`, `resizingCorner`) need **no changes** — the composable returns values under the exact same names the template already references.

- [ ] **Step 3: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual regression test — Terminal must behave identically to before**

Run `cd apps/desktop && pnpm dev:web`, open the Terminal panel and verify, one by one, that nothing changed from its pre-refactor behavior: drag the tab bar to move it; drag the top edge, both side edges, the bottom edge, and all 4 corners to resize; confirm the 300px/120px minimums still hold; confirm double-clicking a tab to rename it does NOT also start a move-drag (this exercises the `moveIgnoreSelector` including `.tp__rename`/`.tp__menu`, not just `button`); switch to bottom-docked mode and confirm the panel can no longer be moved (the `canMove` guard); reload and confirm the previously-set size/position persisted (proves the localStorage keys are unchanged — existing users' saved terminal size/position must not reset). Also open the Files panel at the same time (from this branch's earlier work) and confirm dragging/resizing one panel doesn't affect the other's position — this is the concrete regression this task's extraction could introduce if the composable's state were accidentally left at module scope instead of per-call closure scope.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useDraggableResizable.ts apps/desktop/src/components/TerminalPanel.vue
git commit -m "refactor(desktop): extract useDraggableResizable composable from TerminalPanel"
```

---

### Task 4: Wire `FileExplorerPanel.vue` to `useDraggableResizable`, new default position

**Files:**
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue`

**Interfaces:**
- Consumes: `useDraggableResizable` (Task 3) — same return shape.

**Current code to replace** (`FileExplorerPanel.vue:40-58`):

```typescript
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
```

- [ ] **Step 1: Add the import and replace the position/size block**

Add near the top, with the other composable imports:

```typescript
import { useDraggableResizable } from "../composables/useDraggableResizable";
```

Replace the block above with:

```typescript
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
  initialWidth: Number(localStorage.getItem("gitwand-explorer-width")) || 380,
  initialTop: Number(localStorage.getItem("gitwand-explorer-top")) || 0,
  canMove: () => !bottom.value,
});

onMounted(() => {
  const parent = feRef.value?.parentElement;
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
```

`moveIgnoreSelector` is omitted, so it defaults to `"button"` — `FileExplorerPanel.vue` has no rename-input/dropdown-menu inside its header the way `TerminalPanel.vue` does, so the simpler default is correct here, not an oversight.

Note `onMounted` is already imported (used for `tree.refresh()`); this adds a second `onMounted` call, which Vue supports (both run in registration order).

- [ ] **Step 2: Wire the root element ref and add the handle markup**

In the `<template>`, change the root `<div class="fe" ...>` to add `ref="feRef"`:

```vue
  <div
    ref="feRef"
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
    tabindex="0"
    @keydown="onKeyDown"
  >
```

Right after that opening `<div>` (before `<div class="fe__header">`), add the top drag-to-resize handle:

```vue
    <div v-if="!fullscreen" class="fe__drag" :class="{ 'fe__drag--active': isDragging }" @mousedown="onDragStart" />
```

Right after `.fe__body`'s closing `</div>` (i.e. after the tree+editor row, before the toolbar added in Task 6, or before `</div>` closing `.fe` if Task 6 hasn't landed yet — this task only adds the handles, Task 6 adds the toolbar in between), add the resize/corner handles, floating-mode only:

```vue
    <template v-if="!fullscreen && !bottom">
      <div class="fe__resize-x fe__resize-x--left" :class="{ 'fe__resize-x--active': isResizingL }" @mousedown="onResizeLeftStart" />
      <div class="fe__resize-x" :class="{ 'fe__resize-x--active': isResizingX }" @mousedown="onResizeXStart" />
      <div class="fe__resize-y fe__resize-y--bottom" :class="{ 'fe__resize-y--active': isResizingBottom }" @mousedown="onResizeBottomStart" />
      <div class="fe__corner fe__corner--tl" :class="{ 'fe__corner--active': resizingCorner === 'tl' }" @mousedown="onResizeCornerStart('tl', $event)" />
      <div class="fe__corner fe__corner--tr" :class="{ 'fe__corner--active': resizingCorner === 'tr' }" @mousedown="onResizeCornerStart('tr', $event)" />
      <div class="fe__corner fe__corner--bl" :class="{ 'fe__corner--active': resizingCorner === 'bl' }" @mousedown="onResizeCornerStart('bl', $event)" />
      <div class="fe__corner fe__corner--br" :class="{ 'fe__corner--active': resizingCorner === 'br' }" @mousedown="onResizeCornerStart('br', $event)" />
    </template>
```

- [ ] **Step 3: Add the handle/drag CSS**

In `<style scoped>`, add (anywhere after the existing `.fe--bottom` rule is a reasonable spot):

```css
.fe__drag {
  height: 5px;
  cursor: ns-resize;
  flex-shrink: 0;
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
```

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual smoke test**

Run `cd apps/desktop && pnpm dev:web`, open a repo and click the Files tile. Confirm: the panel opens docked left, under the header, full height; dragging the top edge grows it upward; dragging any corner/edge resizes correctly with a 300px/120px minimum; reload the page and confirm the adjusted size/position persisted. Also re-open the Terminal panel alongside it and confirm both can be dragged/resized independently without interfering with each other.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue
git commit -m "feat(desktop): wire FileExplorerPanel to useDraggableResizable, left-docked full-height default"
```

---

### Task 5: Header redesign — draggable header + fullscreen button

**Files:**
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue`

**Interfaces:**
- Consumes: `files.fullscreen`/`files.exitFullscreen` i18n keys (Task 2), `saveSettings` from `useSettings()` (already-existing composable, just newly destructured here).
- No prop/emit changes.

The existing `.fe__header` row (title + truncated badge + close button) becomes the drag-to-move handle (per Task 4's `onMoveStart`, from the shared `useDraggableResizable` composable) and gains a fullscreen toggle button, mirroring `TerminalPanel.vue`'s `toggleFullscreen`/`.tp__full` button. `FileExplorerPanel.vue` already has its own two-row structure (a title header row, then a separate open-file tabs row) — unlike `TerminalPanel.vue`, which has only one row serving both roles. Putting the move-handle and window-chrome buttons on the always-rendered `.fe__header` (rather than the conditionally-rendered `.fe__tabs`, which doesn't exist when zero tabs are open) is the correct adaptation, not a deviation to flag.

**Current code** (`FileExplorerPanel.vue:21-22`, destructure):

```typescript
const { t } = useI18n();
const { settings } = useSettings();
```

- [ ] **Step 1: Destructure `saveSettings` and add `toggleFullscreen`**

Change the destructure to:

```typescript
const { t } = useI18n();
const { settings, saveSettings } = useSettings();
```

Add this function right after the existing `bottom` computed (`const bottom = computed(() => mode.value === "bottom");`):

```typescript
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
```

- [ ] **Step 2: Update the header template**

Replace the current header block:

```vue
    <div class="fe__header">
      <span class="fe__title">{{ t("files.headerLabel") }}</span>
      <button v-if="tree.truncated.value" class="fe__truncated" :title="t('files.truncatedTooltip')">
        {{ t("files.truncatedBadge") }}
      </button>
      <button class="fe__close" :title="t('common.close')" @click="emit('close')">✕</button>
    </div>
```

with:

```vue
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
        <svg v-if="!fullscreen" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
          <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      </button>
      <button class="fe__close" :title="t('common.close')" @click="emit('close')">✕</button>
    </div>
```

`onMoveStart`'s existing guard (the composable's default `moveIgnoreSelector: "button"`, wired in Task 4) already prevents a click on the fullscreen/close/truncated buttons from also triggering a drag.

- [ ] **Step 3: Style the fullscreen button to match `.fe__close`**

In `<style scoped>`, add right after the existing `.fe__close` rule:

```css
.fe__full {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.fe__full:hover,
.fe__close:hover {
  color: var(--color-text);
}
```

Also update `.fe__header` to indicate it's now a drag handle:

```css
.fe__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  cursor: grab;
}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual smoke test**

`pnpm dev:web`, open the panel: confirm dragging the header moves the panel (and doesn't fire when clicking a header button), the fullscreen button toggles fullscreen and back to the prior layout, and the close button still closes the panel.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue
git commit -m "feat(desktop): make FileExplorerPanel header draggable, add fullscreen toggle"
```

---

### Task 6: Bottom toolbar — lock/unlock, undo, save

**Files:**
- Modify: `apps/desktop/package.json` (add `@codemirror/commands`)
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue`

**Interfaces:**
- Consumes: `files.toolbarEdit`/`files.toolbarLock`/`files.toolbarUndo`/`files.toolbarSave` i18n keys (Task 2), `explorer.saveTab`/`explorer.isDirty` (existing, from `useFileExplorer.ts`).
- No prop/emit changes.

- [ ] **Step 1: Install `@codemirror/commands`**

Run:
```bash
pnpm --filter @gitwand/desktop add @codemirror/commands
```
Expected: `apps/desktop/package.json` gains one new entry under `dependencies`; `pnpm-lock.yaml` updates. (It's already present transitively via `codemirror`'s own dependency on it, so no new code is pulled in — this just makes the direct-import relationship explicit, per the project's convention of listing every directly-imported package.)

- [ ] **Step 2: Add lock state, the editable `Compartment`, and the undo/save handlers**

In `FileExplorerPanel.vue`'s `<script setup>`, first update the CodeMirror lazy-loading block. Replace:

```typescript
// ── CodeMirror 6 (lazy-loaded, one EditorView with per-tab cached EditorState) ──
const editorHost = ref<HTMLElement | null>(null);
let view: EditorViewType | null = null;
let EditorViewCtor: typeof import("@codemirror/view").EditorView | null = null;
let EditorStateCtor: typeof import("@codemirror/state").EditorState | null = null;
let basicSetup: Extension | null = null;
let oneDark: Extension | null = null;
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
  basicSetup = cmMeta.basicSetup;
  oneDark = theme;
}
```

with:

```typescript
// ── CodeMirror 6 (lazy-loaded, one EditorView with per-tab cached EditorState) ──
const editorHost = ref<HTMLElement | null>(null);
let view: EditorViewType | null = null;
let EditorViewCtor: typeof import("@codemirror/view").EditorView | null = null;
let EditorStateCtor: typeof import("@codemirror/state").EditorState | null = null;
let CompartmentCtor: typeof import("@codemirror/state").Compartment | null = null;
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

async function ensureCodeMirrorLibs() {
  if (EditorViewCtor) return;
  const [{ EditorView }, { EditorState, Compartment }, cmMeta, { oneDark: theme }, { undo }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("codemirror"),
    import("@codemirror/theme-one-dark"),
    import("@codemirror/commands"),
  ]);
  EditorViewCtor = EditorView;
  EditorStateCtor = EditorState;
  CompartmentCtor = Compartment;
  basicSetup = cmMeta.basicSetup;
  oneDark = theme;
  undoCommand = undo;
  editableCompartment = new Compartment();
}
```

- [ ] **Step 3: Bake the compartment into new `EditorState`s and re-assert it on every mount**

Replace `mountTab`:

```typescript
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

  await nextTick();
  if (!editorHost.value) return;
  if (activeTab.value?.id !== tab.id) return; // re-check after nextTick too

  let state = docStates.get(tab.id);
  if (!state) {
    const langExt = await detectLanguageExtension(tab.path);
    if (activeTab.value?.id !== tab.id) return; // a newer tab switch happened while the grammar was loading — don't touch the shared view/docStates with a stale tab's state
    state = EditorStateCtor!.create({
      doc: tab.content,
      extensions: [basicSetup!, oneDark!, langExt, updateListenerFor(tab.id)],
    });
    docStates.set(tab.id, state);
  }

  if (!view) {
    view = new EditorViewCtor!({ state, parent: editorHost.value });
  } else {
    view.setState(state);
  }
}
```

with:

```typescript
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
  view.dispatch({ effects: editableCompartment!.reconfigure(EditorViewCtor!.editable.of(!editLocked.value)) });
  docStates.set(tab.id, view.state);
}
```

- [ ] **Step 4: Add `toggleLock`, `onUndo`, `onToolbarSave`**

Add these functions right after `mountTab`, before the `watch(activeTab, ...)` call:

```typescript
function toggleLock() {
  editLocked.value = !editLocked.value;
  if (view && activeTab.value && editableCompartment && EditorViewCtor) {
    view.dispatch({ effects: editableCompartment.reconfigure(EditorViewCtor.editable.of(!editLocked.value)) });
    docStates.set(activeTab.value.id, view.state);
  }
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
```

- [ ] **Step 5: Add the toolbar to the template**

Right after `.fe__body`'s closing `</div>` (and after Task 4's resize-handle `<template>` block, if that's already in place — order between the two doesn't matter functionally, but keep the toolbar as the last child of `.fe` before its own closing `</div>`), add:

```vue
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
```

- [ ] **Step 6: Add the toolbar CSS**

In `<style scoped>`, add:

```css
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
```

- [ ] **Step 7: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 8: Manual smoke test**

`pnpm dev:web`, open a file: confirm it's not editable while locked (typing does nothing), click "Edit" to unlock, type something, confirm the dirty dot appears and the Save button becomes enabled, click Undo and confirm it reverts the last keystroke, click Save and confirm it persists to disk (matches `⌘S`'s existing behavior), re-lock and confirm Save stays enabled if there's still a pending unsaved edit, switch tabs and confirm the lock state carries over (doesn't reset to locked).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/components/FileExplorerPanel.vue
git commit -m "feat(desktop): add lock/undo/save toolbar to FileExplorerPanel"
```

---

### Task 7: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd apps/desktop && pnpm test`
Expected: all tests pass, including the updated `useRepoFileTree.test.ts`.

- [ ] **Step 2: Full type-check and build**

Run: `cd apps/desktop && pnpm build`
Expected: builds cleanly.

- [ ] **Step 3: End-to-end manual walkthrough with `pnpm dev:web`**

1. Open a repo, click the Files tile — panel opens docked left, top under the header, full height, tree fully collapsed.
2. Drag the header to move the panel; drag each resize edge/corner; reload and confirm persistence.
3. Toggle fullscreen from the header button and back.
4. Expand a folder, open a file (still read-only — typing does nothing).
5. Click "Edit" (unlock), type a change, confirm dirty dot + Save button enabled.
6. Click Undo, confirm the last keystroke is reverted.
7. Click Save, confirm the file is written (check via `git diff`, then revert the test edit).
8. Re-lock, confirm Save is still enabled if a dirty edit remains; switch tabs and confirm lock state is unchanged (global, not per-tab).
9. Confirm all labels (Edit/Lock/Undo/Save, fullscreen tooltip) are present and, switching the app to French, translated.
10. Confirm the Terminal panel is unaffected — open both panels simultaneously, drag/resize each independently without interference.

- [ ] **Step 4: Report results**

If every check passes and Steps 1-2 are green, the feature is complete. If any check fails, fix forward with a new task-scoped commit rather than amending.
