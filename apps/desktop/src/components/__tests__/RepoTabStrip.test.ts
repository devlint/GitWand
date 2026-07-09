/**
 * RepoTabStrip.vue — pointer-based drag-to-reorder regression guards.
 *
 * Native HTML5 drag-and-drop is unreliable in the WebKit webviews that power
 * the packaged Tauri app, so tab reordering is driven by plain mouse events
 * instead (see the "Drag to reorder" comment block in the component). That
 * hand-rolled state machine has sharp edges a component test can pin down
 * without a real browser: a click near a tab's own edge must not itself
 * register as a reorder, and a drag must only ever be committed by the
 * button (and only that button) that started it.
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
function stubRects(tabEls: HTMLElement[], widths: number[]) {
  let left = 0;
  for (let i = 0; i < tabEls.length; i++) {
    const width = widths[i];
    const rect = { left, right: left + width, top: 0, bottom: 30, width, height: 30 } as DOMRect;
    tabEls[i].getBoundingClientRect = () => rect;
    left += width;
  }
}

function fireMouse(target: EventTarget, type: string, opts: Partial<MouseEvent> & { clientX?: number; clientY?: number; button?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: opts.button ?? 0 });
  Object.defineProperty(event, "clientX", { get: () => opts.clientX ?? 0 });
  Object.defineProperty(event, "clientY", { get: () => opts.clientY ?? 15 });
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
    fireMouse(tabEls[0], "mousedown", { clientX: 90 });
    // Wobble 5px right — just past the 4px drag threshold.
    fireMouse(window, "mousemove", { clientX: 95 });
    fireMouse(window, "mouseup", { clientX: 95 });
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("dragging a tab past its neighbour's center reorders it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    // Press at the center of tab 0 and drag well past tab 1's center (150).
    fireMouse(tabEls[0], "mousedown", { clientX: 50 });
    fireMouse(window, "mousemove", { clientX: 160 });
    fireMouse(window, "mouseup", { clientX: 160 });
    await nextTick();

    expect(reorders).toEqual([[0, 1]]);
  });

  it("a right-click released mid-drag does not commit or cancel it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    fireMouse(tabEls[0], "mousedown", { clientX: 50, button: 0 });
    fireMouse(window, "mousemove", { clientX: 160 });
    // A right-button mouseup mid-drag must be ignored...
    fireMouse(window, "mouseup", { clientX: 160, button: 2 });
    await nextTick();
    expect(reorders).toEqual([]);
    // ...the left-button release still ends the drag normally.
    fireMouse(window, "mouseup", { clientX: 160, button: 0 });
    await nextTick();
    expect(reorders).toEqual([[0, 1]]);
  });

  it("releasing far outside the strip cancels the drag instead of reordering", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    fireMouse(tabEls[0], "mousedown", { clientX: 50 });
    // Drag past tab 1's center but with the cursor far below the strip.
    fireMouse(window, "mousemove", { clientX: 160, clientY: 500 });
    fireMouse(window, "mouseup", { clientX: 160, clientY: 500 });
    await nextTick();

    expect(reorders).toEqual([]);
  });

  it("a window blur mid-drag cancels it", async () => {
    const { tabEls, reorders } = mount(makeTabs(3));
    stubRects(tabEls, [100, 100, 100]);

    fireMouse(tabEls[0], "mousedown", { clientX: 50 });
    fireMouse(window, "mousemove", { clientX: 160 });
    window.dispatchEvent(new Event("blur"));
    // The mouseup that follows (returning from another app) must not commit.
    fireMouse(window, "mouseup", { clientX: 160 });
    await nextTick();

    expect(reorders).toEqual([]);
  });
});
