// @vitest-environment jsdom
/**
 * useLineRange — click / Shift+click ranges of rows within one group (a
 * hunk, a hunk's column), shared by the commit and PR diffs (#301).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, defineComponent, h, type App } from "vue";
import { useLineRange, preventShiftSelect } from "../useLineRange";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

/** Mount a component using the composable; returns its API. */
function withRange(opts?: Parameters<typeof useLineRange>[0]) {
  let api!: ReturnType<typeof useLineRange>;
  app = createApp(
    defineComponent({
      setup() {
        api = useLineRange(opts);
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  return api;
}

describe("useLineRange", () => {
  it("a pick starts a range, an extend in the same group grows it either way", () => {
    const r = withRange();
    r.pick("h1", 5, false);
    expect(r.range.value).toEqual({ group: "h1", anchor: 5, focus: 5, lo: 5, hi: 5 });
    r.pick("h1", 2, true);
    expect(r.range.value).toMatchObject({ lo: 2, hi: 5, anchor: 5 });
    r.pick("h1", 8, true);
    expect(r.range.value).toMatchObject({ lo: 5, hi: 8 });
    expect(r.isIn("h1", 6)).toBe(true);
    expect(r.isIn("h1", 4)).toBe(false);
    expect(r.isIn("h2", 6)).toBe(false);
  });

  it("an extend in another group starts over there", () => {
    const r = withRange();
    r.pick("h1", 5, false);
    r.pick("h2", 1, true);
    expect(r.range.value).toEqual({ group: "h2", anchor: 1, focus: 1, lo: 1, hi: 1 });
  });

  it("Escape on the diff clears it and lets the key go on; not under a dialog or once handled", () => {
    const r = withRange({ dismiss: { keep: ".keep" } });
    r.pick("h", 1, false);
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    r.onKeydown(handled);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    r.onKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(r.range.value).not.toBeNull();
    dialog.remove();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    const stop = vi.spyOn(esc, "stopPropagation");
    r.onKeydown(esc);
    expect(r.range.value).toBeNull();
    // Menus and overlays listening further up still get it.
    expect(stop).not.toHaveBeenCalled();
  });

  it("an Escape elsewhere in the document leaves it alone", () => {
    const r = withRange({ dismiss: { keep: ".keep" } });
    r.pick("h", 1, false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(r.range.value).not.toBeNull();
  });

  it("a press elsewhere clears it; not on kept elements nor on the scroll area", () => {
    const scroller = document.createElement("div");
    const keep = document.createElement("span");
    keep.className = "keep";
    document.body.append(scroller, keep);
    const r = withRange({ dismiss: { keep: ".keep", scrollEl: () => scroller } });
    r.pick("h", 1, false);
    keep.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    scroller.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(r.range.value).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(r.range.value).toBeNull();
  });

  it("without dismiss options, nothing outside clears it", () => {
    const r = withRange();
    r.pick("h", 1, false);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(r.range.value).not.toBeNull();
    r.clear();
    expect(r.range.value).toBeNull();
  });

  it("Shift+press does not start the browser's own text selection", () => {
    const shift = new MouseEvent("mousedown", { shiftKey: true, cancelable: true });
    preventShiftSelect(shift);
    expect(shift.defaultPrevented).toBe(true);
    const plain = new MouseEvent("mousedown", { cancelable: true });
    preventShiftSelect(plain);
    expect(plain.defaultPrevented).toBe(false);
  });
});
