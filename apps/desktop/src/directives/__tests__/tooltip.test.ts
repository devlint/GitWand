// @vitest-environment jsdom
/**
 * v-tooltip — `updated` runs on every parent re-render (AppHeader re-renders
 * many times a second during a fetch). It must not stack trigger listeners,
 * nor tear down a visible tooltip whose content did not change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vTooltip } from "../tooltip";

const tips = () => document.querySelectorAll(".gw-tooltip");

function mount(value: unknown) {
  const el = document.createElement("button");
  document.body.appendChild(el);
  vTooltip.mounted(el, { value });
  return el;
}

describe("v-tooltip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not stack listeners across updates", () => {
    const el = mount({ text: "Stash" });
    for (let i = 0; i < 50; i++) vTooltip.updated(el, { value: { text: "Stash" } });

    const appendSpy = vi.spyOn(document.body, "appendChild");
    el.dispatchEvent(new Event("mouseenter"));
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(tips()).toHaveLength(1);
  });

  it("keeps a visible tooltip across an update with the same text", () => {
    const el = mount({ text: "Stash" });
    el.dispatchEvent(new Event("mouseenter"));
    const tip = tips()[0];

    vTooltip.updated(el, { value: { text: "Stash" } });
    expect(tips()).toHaveLength(1);
    expect(tips()[0]).toBe(tip);
  });

  it("updates the text of a visible tooltip in place", () => {
    const el = mount({ text: "Stash" });
    el.dispatchEvent(new Event("mouseenter"));

    vTooltip.updated(el, { value: { text: "Stash (2)" } });
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toBe("Stash (2)");
  });

  it("hides a visible tooltip once `when` turns false", () => {
    let iconMode = true;
    const value = { text: "Stash", when: () => iconMode };
    const el = mount(value);
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toHaveLength(1);

    iconMode = false;
    vTooltip.updated(el, { value });
    expect(tips()).toHaveLength(0);

    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toHaveLength(0);
  });

  it("uses the latest value, including one that starts empty", () => {
    const el = mount("");
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toHaveLength(0);

    vTooltip.updated(el, { value: "Push" });
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()[0].textContent).toBe("Push");
  });

  it("hides a visible tooltip when a resize flips `when`", () => {
    let labelHidden = true;
    const el = mount({ text: "Stash", when: () => labelHidden });
    el.dispatchEvent(new Event("focus"));
    expect(tips()).toHaveLength(1);

    labelHidden = false; // window widened past the breakpoint
    window.dispatchEvent(new Event("resize"));
    expect(tips()).toHaveLength(0);
  });

  it("passes the anchor element to `when`", () => {
    const when = vi.fn(() => true);
    const el = mount({ text: "Stash", when });
    el.dispatchEvent(new Event("mouseenter"));
    expect(when).toHaveBeenCalledWith(el);
  });

  it("re-shows a visible tooltip when its position changes", () => {
    const el = mount({ text: "Stash", position: "top" });
    el.dispatchEvent(new Event("mouseenter"));
    const tip = tips()[0];

    vTooltip.updated(el, { value: { text: "Stash", position: "left" } });
    expect(tips()).toHaveLength(1);
    expect(tips()[0]).not.toBe(tip);
  });

  it("removes its listeners on unmount", () => {
    const el = mount("Push");
    vTooltip.beforeUnmount(el);
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toHaveLength(0);
  });
});
