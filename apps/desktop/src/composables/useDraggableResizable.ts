import { onBeforeUnmount, ref, type Ref } from "vue";

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

  // Defensive cleanup — mirrors the removeEventListener block that used to sit
  // in TerminalPanel.vue's own onBeforeUnmount. If the panel unmounts (or is
  // KeepAlive-deactivated) mid-drag/resize, these ensure no stray window
  // listener or lingering cursor/userSelect style survives it. Kept inside the
  // composable (not the caller) because the composable owns these handler
  // references — TerminalPanel.vue no longer has access to them post-extraction.
  onBeforeUnmount(() => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
    window.removeEventListener("mousemove", onMoveMove);
    window.removeEventListener("mouseup", onMoveEnd);
    window.removeEventListener("mousemove", onResizeXMove);
    window.removeEventListener("mouseup", onResizeXEnd);
    window.removeEventListener("mousemove", onResizeLeftMove);
    window.removeEventListener("mouseup", onResizeLeftEnd);
    window.removeEventListener("mousemove", onResizeCornerMove);
    window.removeEventListener("mouseup", onResizeCornerEnd);
    window.removeEventListener("mousemove", onResizeBottomMove);
    window.removeEventListener("mouseup", onResizeBottomEnd);
  });

  return {
    height, left, width, top,
    isDragging, isResizingX, isResizingL, isResizingBottom, resizingCorner,
    onDragStart, onMoveStart, onResizeXStart, onResizeLeftStart, onResizeBottomStart, onResizeCornerStart,
  };
}
