// @vitest-environment jsdom
/**
 * useCollapseOnOverflow — items collapse one at a time, in
 * `data-collapse-order`, only as far as the row needs to fit at full size
 * (measured with every item expanded first), and expand again once there is
 * room. jsdom has no layout: element rects are faked from which items are
 * collapsed. Mounted with native `createApp` (no @vue/test-utils dep).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, ref, nextTick, type App, type VNode } from "vue";
import { useCollapseOnOverflow } from "../useCollapseOnOverflow";

const CLASS = "is-icon";
const FULL = 100; // px per expanded item
const ICON = 40; // px per collapsed item

let room = 600;
let roCallback: () => void = () => {};
const observe = vi.fn();
const unobserve = vi.fn();
class FakeResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb;
  }
  observe = observe;
  unobserve = unobserve;
  disconnect() {}
}

const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 20 }) as DOMRect;

/** Row and group are `room` wide; items sit side by side from x = 0. */
function fakeRect(this: Element): DOMRect {
  const el = this as HTMLElement;
  if (el.dataset.row || el.dataset.group) return rect(0, room);
  if (el.dataset.popover) return rect(0, 5000); // an open menu sticking far out
  if (el.dataset.collapseKey) {
    let left = 0;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if ((s as HTMLElement).dataset.collapseKey) left += s.classList.contains(CLASS) ? ICON : FULL;
    }
    return rect(left, left + (el.classList.contains(CLASS) ? ICON : FULL));
  }
  return rect(0, 0);
}

let app: App | null = null;

type Item = { key: string; order?: number };

function mountRow(items: Item[] | (() => Item[]), extra: () => VNode[] = () => []) {
  const list = typeof items === "function" ? items : () => items;
  let collapsed!: ReturnType<typeof useCollapseOnOverflow>["collapsed"];
  const Comp = defineComponent({
    setup() {
      const row = ref<HTMLElement | null>(null);
      ({ collapsed } = useCollapseOnOverflow(row, CLASS));
      return () =>
        h("div", { ref: row, "data-row": "1" }, [
          h(
            "div",
            { "data-group": "1" },
            list().map((i) =>
              h("button", { key: i.key, "data-collapse-key": i.key, "data-collapse-order": i.order }),
            ),
          ),
          ...extra(),
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
const ACTIONS: Item[] = [
  { key: "stash", order: 5 },
  { key: "tags", order: 4 },
  { key: "worktrees", order: 3 },
  { key: "submodules", order: 2 },
  { key: "releaseNotes", order: 1 },
];

describe("useCollapseOnOverflow", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(fakeRect);
    room = 600;
    observe.mockClear();
    unobserve.mockClear();
  });
  afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("follows data-collapse-order, not DOM order; items without one collapse last", () => {
    room = 380; // two collapses
    const { iconKeys } = mountRow([
      { key: "none" },
      { key: "b", order: 3 },
      { key: "a", order: 1 },
      { key: "d", order: 4 },
      { key: "c", order: 2 },
    ]);
    expect(iconKeys().sort()).toEqual(["a", "c"]);
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

  it("ignores an absolutely positioned popover sticking out of the row", () => {
    room = 500; // the items fit exactly
    const { iconKeys } = mountRow(ACTIONS, () => [
      h("div", { "data-popover": "1", style: "position: absolute" }),
    ]);
    expect(iconKeys()).toEqual([]);
  });

  it("observes children rendered later and unobserves removed ones", async () => {
    const show = ref(false);
    const { row } = mountRow(ACTIONS, () => (show.value ? [h("span", { class: "late" })] : []));
    expect(observe).toHaveBeenCalledWith(row);

    show.value = true;
    await nextTick();
    const late = row.querySelector(".late");
    expect(observe).toHaveBeenCalledWith(late);

    show.value = false;
    await nextTick();
    expect(unobserve).toHaveBeenCalledWith(late);
  });
});
