/**
 * RepoTabStrip.vue — pointer-based drag-to-reorder regression guards.
 *
 * Native HTML5 drag-and-drop is unreliable in the WebKit webviews that power
 * the packaged Tauri app, so tab reordering is driven by Pointer Events
 * instead (see the "Drag to reorder" comment block in the component) — one
 * code path for mouse, touch and pen. That hand-rolled state machine has
 * sharp edges a component test can pin down without a real browser: a click
 * near a tab's own edge must not itself register as a reorder, a drag must
 * only ever be committed by the button that started it, and a re-snapshot
 * mid-drag (scroll, resize) must not double-count the dragged tab's own live
 * offset.
 *
 * jsdom has no PointerEvent constructor and no setPointerCapture, so drags
 * are driven with plain `Event` objects carrying the same fields the
 * component reads off a real PointerEvent (clientX/clientY/button/pointerId)
 * — dispatchEvent doesn't care which Event subclass a listener was declared
 * against, only the `type` string. The component itself feature-detects
 * setPointerCapture, so it degrades to window-listener-only tracking under
 * jsdom exactly like it would in a webview that lacks pointer capture.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep),
 * mirroring MergeEditor.test / LlmTracePanel.test / LaunchpadView.test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import RepoTabStrip from "../header/RepoTabStrip.vue";
import type { RepoTab } from "../../composables/useRepoTabs";

function makeTabs(n: number): RepoTab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    path: `/repo-${i}`,
    name: `repo-${i}`,
  }));
}

let app: App | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
});

interface Mounted {
  tabEls: HTMLElement[];
  reorders: Array<[number, number]>;
}

function mount(tabs: RepoTab[]): Mounted {
  container = document.createElement("div");
  document.body.appendChild(container);
  const reorders: Array<[number, number]> = [];

  app = createApp({
    render() {
      return h(RepoTabStrip, {
        tabs,
        activeTabId: tabs[0]?.id ?? null,
        onReorderTabs: (oldIndex: number, newIndex: number) => {
          reorders.push([oldIndex, newIndex]);
        },
      });
    },
  });
  app.mount(container);

  const tabEls = Array.from(container.querySelectorAll<HTMLElement>(".repo-tab"));
  return { tabEls, reorders };
}

/** Stubs the geometry each tab needs for the drag hit-test to run in jsdom. */
function stubRects(tabEls: HTMLElement[], widths: number[], lefts?: number[]) {
  let left = 0;
  for (let i = 0; i < tabEls.length; i++) {
    const width = widths[i];
    const l = lefts ? lefts[i] : left;
    const rect = { left: l, right: l + width, top: 0, bottom: 30, width, height: 30 } as DOMRect;
    tabEls[i].getBoundingClientRect = () => rect;
    left += width;
  }
}

let nextPointerId = 1;

function firePointer(
  target: EventTarget,
  type: string,
  opts: { clientX?: number; clientY?: number; button?: number; pointerId?: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { get: () => opts.clientX ?? 0 });
  Object.defineProperty(event, "clientY", { get: () => opts.clientY ?? 15 });
  Object.defineProperty(event, "button", { get: () => opts.button ?? 0 });
  Object.defineProperty(event, "pointerId", { get: () => opts.pointerId ?? nextPointerId });
  target.dispatchEvent(event);
}

describe("RepoTabStrip — drag to reorder", () => {
  it("a few pixels of wobble on a tab's right half does not reorder it", async () => {
    // Regression: the hit-test used to compare the raw cursor position
    // against each tab's center, so pressing the right half of a wide tab
    // put the cursor on the far side of its own center *before any
    // movement at all* — a subsequent few-pixel wobble (well under what
    // anyone would call a drag) was enough to swap it with its neighbour.
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    // Press near the right edge of tab 0 (center is at x=50).
    firePointer(tabEls[0], "pointerdown", { clientX: 90 });
    // Wobble 5px right — just past the 4px drag threshold.
    firePointer(window, "pointermove", { clientX: 95 });
    firePointer(window, "pointerup", { clientX: 95 });
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("dragging a tab past its neighbour's center reorders it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    // Press at the center of tab 0 and drag well past tab 1's center (150).
    firePointer(tabEls[0], "pointerdown", { clientX: 50 });
    firePointer(window, "pointermove", { clientX: 160 });
    firePointer(window, "pointerup", { clientX: 160 });
    await nextTick();

    expect(reorders).toEqual([[0, 1]]);
  });

  it("a right-click released mid-drag does not commit or cancel it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    firePointer(tabEls[0], "pointerdown", { clientX: 50, button: 0 });
    firePointer(window, "pointermove", { clientX: 160 });
    // A right-button pointerup mid-drag must be ignored...
    firePointer(window, "pointerup", { clientX: 160, button: 2 });
    await nextTick();
    expect(reorders).toEqual([]);
    // ...the left-button release still ends the drag normally.
    firePointer(window, "pointerup", { clientX: 160, button: 0 });
    await nextTick();
    expect(reorders).toEqual([[0, 1]]);
  });

  it("releasing far outside the strip cancels the drag instead of reordering", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    firePointer(tabEls[0], "pointerdown", { clientX: 50 });
    // Drag past tab 1's center but with the cursor far below the strip.
    firePointer(window, "pointermove", { clientX: 160, clientY: 500 });
    firePointer(window, "pointerup", { clientX: 160, clientY: 500 });
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("a window blur mid-drag cancels it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    firePointer(tabEls[0], "pointerdown", { clientX: 50 });
    firePointer(window, "pointermove", { clientX: 160 });
    window.dispatchEvent(new Event("blur"));
    // The pointerup that follows (returning from another app) must not commit.
    firePointer(window, "pointerup", { clientX: 160 });
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("a pointercancel mid-drag (e.g. a touch gesture interrupted) cancels it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    firePointer(tabEls[0], "pointerdown", { clientX: 50 });
    firePointer(window, "pointermove", { clientX: 160 });
    firePointer(window, "pointercancel", { clientX: 160 });
    firePointer(window, "pointerup", { clientX: 160 });
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("a resize mid-drag re-snapshots without double-counting the dragged tab's own offset", async () => {
    // Regression: re-snapshotting centers mid-drag (on scroll or resize) used
    // to re-measure the dragged tab's rect as-is — but that rect already
    // includes the live translateX a real browser would have painted, so the
    // offset got added to the hit-test a second time and the drop landed one
    // slot further than it should have.
    const { tabEls, reorders } = mount(makeTabs(3));
    // Resting centers: 50, 150, 250 (widths 100 each, lefts 0/100/200).
    stubRects(tabEls, [100, 100, 100]);

    firePointer(tabEls[0], "pointerdown", { clientX: 50 });
    // Drag 100px right — didDrag flips true and snapshots the resting
    // centers; hoveredIndex is still 0 (hasn't crossed tab 1's center yet).
    firePointer(window, "pointermove", { clientX: 150 });

    // Simulate the DOM now reflecting that 100px live translateX: tab 0's
    // rect has visually shifted right by 100, exactly as a real browser
    // would render it mid-drag (the other tabs don't move).
    stubRects(tabEls, [100, 100, 100], [100, 100, 200]);
    window.dispatchEvent(new Event("resize"));

    // Move on to a total offset of 110px from the press point — enough to
    // cross tab 1's resting center (150) but not tab 2's (250) once the
    // resize re-snapshot has correctly stripped the baked-in offset back out.
    firePointer(window, "pointermove", { clientX: 160 });
    firePointer(window, "pointerup", { clientX: 160 });
    await nextTick();

    expect(reorders).toEqual([[0, 1]]);
  });
});

describe("RepoTabStrip — keyboard reordering", () => {
  function fireCtrlShiftArrow(target: EventTarget, key: "ArrowLeft" | "ArrowRight") {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
  }

  it("Ctrl+Shift+ArrowRight moves the focused tab one slot right and announces it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));

    fireCtrlShiftArrow(tabEls[0], "ArrowRight");
    await nextTick();

    expect(reorders).toEqual([[0, 1]]);
    expect(container?.querySelector('[role="status"]')?.textContent).toBe("repo-0 moved to position 2 of 3");
  });

  it("Ctrl+Shift+ArrowLeft moves the focused tab one slot left", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));

    fireCtrlShiftArrow(tabEls[1], "ArrowLeft");
    await nextTick();

    expect(reorders).toEqual([[1, 0]]);
  });

  it("does nothing at the boundary (first tab can't move left, last can't move right)", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));

    fireCtrlShiftArrow(tabEls[0], "ArrowLeft");
    fireCtrlShiftArrow(tabEls[2], "ArrowRight");
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("a plain ArrowRight (no modifier) does not reorder — only switches focus natively", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));

    tabEls[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("bare Ctrl+ArrowRight (no Shift) does not reorder", async () => {
    // Regression: a bare Ctrl+Arrow is macOS's default Mission Control
    // "switch Space" shortcut, intercepted by the OS before it would even
    // reach the app — Shift is required precisely to stay clear of that (and
    // of third-party window-manager shortcuts using the same bare combo).
    // This only guards our own handler's condition; it can't simulate the
    // OS swallowing the event outright.
    const { tabEls, reorders } = mount(makeTabs(3));

    tabEls[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await nextTick();

    expect(reorders).toEqual([]);
  });
});
