// @vitest-environment jsdom
/**
 * useCompactOnOverflow — the compact class must follow whether the content
 * fits at FULL size (measured with the class removed), so it neither sticks
 * once there is room again nor flips back on while the content overflows.
 * jsdom has no layout: widths are faked from the row's class.
 * Mounted with native `createApp` (no @vue/test-utils dep).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, ref, nextTick, type App } from "vue";
import { useCompactOnOverflow } from "../useCompactOnOverflow";

const CLASS = "row--compact";

/** Child content is `full` px wide with labels, `compact` px without; the row has `room` px. */
const widths = { full: 700, compact: 300, room: 600 };

let roCallback: () => void = () => {};
const observe = vi.fn((node: Element) => {
  // Fake the layout as soon as the composable starts watching a child —
  // onMounted observes before its first check.
  const row = node.parentElement;
  if (!row?.dataset.row) return;
  const content = () => (row.classList.contains(CLASS) ? widths.compact : widths.full);
  Object.defineProperty(node, "scrollWidth", { get: content, configurable: true });
  Object.defineProperty(node, "clientWidth", { get: () => widths.room, configurable: true });
});
class FakeResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb;
  }
  observe = observe;
  disconnect() {}
}

let app: App | null = null;

function mountRow(children: () => ReturnType<typeof h>[] = () => [h("div")]) {
  let compact!: ReturnType<typeof useCompactOnOverflow>["compact"];
  const Comp = defineComponent({
    setup() {
      const row = ref<HTMLElement | null>(null);
      ({ compact } = useCompactOnOverflow(row, CLASS));
      return () => h("div", { ref: row, "data-row": "1" }, children());
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Comp);
  app.mount(container);
  return { row: container.firstElementChild as HTMLElement, compact };
}

describe("useCompactOnOverflow", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    widths.full = 700;
    widths.room = 600;
    observe.mockClear();
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("goes compact when the full-size content overflows", () => {
    const { row, compact } = mountRow();
    expect(row.classList.contains(CLASS)).toBe(true);
    expect(compact.value).toBe(true);
  });

  it("stays compact on re-check while the full size still overflows", () => {
    const { row } = mountRow();
    roCallback(); // the class toggle resizes the children, re-firing the observer
    roCallback();
    expect(row.classList.contains(CLASS)).toBe(true);
  });

  it("drops compact once there is room for the full size again", () => {
    const { row, compact } = mountRow();
    widths.room = 800; // window widened
    roCallback();
    expect(row.classList.contains(CLASS)).toBe(false);
    expect(compact.value).toBe(false);
  });

  it("stays full-size when the content fits", () => {
    widths.full = 500;
    const { row } = mountRow();
    expect(row.classList.contains(CLASS)).toBe(false);
  });

  it("observes the row and children rendered later", async () => {
    const show = ref(false);
    const { row } = mountRow(() => (show.value ? [h("span", { class: "late" })] : []));
    expect(observe).toHaveBeenCalledWith(row);
    show.value = true;
    await nextTick();
    expect(observe).toHaveBeenCalledWith(row.querySelector(".late"));
  });
});
