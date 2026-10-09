// @vitest-environment jsdom
/**
 * useCollapseOnOverflow — items collapse one at a time, in
 * `data-collapse-order`, only as far as the row needs to fit at full size
 * (measured with every item expanded first), and expand again once there is
 * room. jsdom has no layout: the child's width is faked from which items are
 * collapsed. Mounted with native `createApp` (no @vue/test-utils dep).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, ref, nextTick, type App } from "vue";
import { useCollapseOnOverflow } from "../useCollapseOnOverflow";

const CLASS = "is-icon";
const FULL = 100; // px per expanded item
const ICON = 40; // px per collapsed item

let room = 600;
let roCallback: () => void = () => {};
const observe = vi.fn((node: Element) => {
  // Fake the layout once the composable watches the group — onMounted
  // observes before its first check.
  if (!(node as HTMLElement).dataset?.group) return;
  const content = () =>
    Array.from(node.children).reduce((w, c) => w + (c.classList.contains(CLASS) ? ICON : FULL), 0);
  Object.defineProperty(node, "scrollWidth", { get: content, configurable: true });
  Object.defineProperty(node, "clientWidth", { get: () => room, configurable: true });
});
class FakeResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb;
  }
  observe = observe;
  disconnect() {}
}

let app: App | null = null;

/** Items in DOM order; `order` decides which collapses first. */
function mountRow(items: { key: string; order: number }[] | (() => { key: string; order: number }[])) {
  const list = typeof items === "function" ? items : () => items;
  let collapsed!: ReturnType<typeof useCollapseOnOverflow>["collapsed"];
  const Comp = defineComponent({
    setup() {
      const row = ref<HTMLElement | null>(null);
      ({ collapsed } = useCollapseOnOverflow(row, CLASS));
      return () =>
        h("div", { ref: row }, [
          h(
            "div",
            { "data-group": "1" },
            list().map((i) =>
              h("button", { key: i.key, "data-collapse-key": i.key, "data-collapse-order": i.order }),
            ),
          ),
        ]);
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Comp);
  app.mount(container);
  const row = container.firstElementChild as HTMLElement;
  const iconKeys = () =>
    Array.from(row.querySelectorAll(`.${CLASS}`)).map((b) => (b as HTMLElement).dataset.collapseKey);
  return { row, iconKeys, collapsed: () => [...collapsed.value].sort() };
}

// Five items, DOM order left → right; the rightmost collapses first.
const ACTIONS = [
  { key: "stash", order: 5 },
  { key: "tags", order: 4 },
  { key: "worktrees", order: 3 },
  { key: "submodules", order: 2 },
  { key: "releaseNotes", order: 1 },
];

describe("useCollapseOnOverflow", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    room = 600;
    observe.mockClear();
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("keeps every label when the full row fits", () => {
    room = 500;
    const { iconKeys } = mountRow(ACTIONS);
    expect(iconKeys()).toEqual([]);
  });

  it("collapses only as many items as needed, lowest order first", () => {
    room = 440; // 500 full → one collapse (440) fits
    const one = mountRow(ACTIONS);
    expect(one.iconKeys()).toEqual(["releaseNotes"]);
    app!.unmount();

    room = 330; // needs three collapses: 500 → 440 → 380 → 320
    const three = mountRow(ACTIONS);
    expect(three.collapsed()).toEqual(["releaseNotes", "submodules", "worktrees"]);
  });

  it("follows data-collapse-order, not DOM order", () => {
    room = 440;
    const { iconKeys } = mountRow([
      { key: "a", order: 1 },
      { key: "b", order: 3 },
      { key: "c", order: 2 },
      { key: "d", order: 4 },
      { key: "e", order: 5 },
    ]);
    expect(iconKeys()).toEqual(["a"]);
  });

  it("collapses everything when even that is too wide, without looping", () => {
    room = 100;
    const { iconKeys } = mountRow(ACTIONS);
    expect(iconKeys()).toHaveLength(5);
  });

  it("expands again once the row widens, and stays stable on re-checks", () => {
    room = 330;
    const { iconKeys } = mountRow(ACTIONS);
    roCallback(); // a collapse resizes the children and re-fires the observer
    expect(iconKeys()).toHaveLength(3);

    room = 440;
    roCallback();
    expect(iconKeys()).toEqual(["releaseNotes"]);
  });

  it("observes the row and children rendered later", async () => {
    const show = ref(false);
    const { row } = mountRow(() => (show.value ? ACTIONS : []));
    expect(observe).toHaveBeenCalledWith(row);
    // the group itself is a direct child rendered from the start
    expect(observe).toHaveBeenCalledWith(row.firstElementChild);
    show.value = true;
    await nextTick();
    expect(row.querySelectorAll("[data-collapse-key]")).toHaveLength(5);
  });
});
