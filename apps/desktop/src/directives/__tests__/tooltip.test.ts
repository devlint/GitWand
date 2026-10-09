// @vitest-environment jsdom
/**
 * v-tooltip — `updated` runs on every parent re-render (AppHeader re-renders
 * many times a second during a fetch). It must not stack trigger listeners,
 * nor tear down a visible tooltip whose content did not change. A hidden
 * tooltip fades out before removal; icon-only anchors get its text as their
 * accessible name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vTooltip } from "../tooltip";

/** Live tooltips — a hidden one lingers while it fades out (`--leaving`). */
const tips = () => document.querySelectorAll(".gw-tooltip:not(.gw-tooltip--leaving)");

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

  it("fades a hidden tooltip out, then removes it", () => {
    vi.useFakeTimers();
    try {
      const el = mount("bye");
      el.dispatchEvent(new Event("mouseenter"));
      el.dispatchEvent(new Event("mouseleave"));
      const tip = document.querySelector(".gw-tooltip");
      expect(tip?.classList.contains("gw-tooltip--leaving")).toBe(true);
      expect(tip?.classList.contains("gw-tooltip--visible")).toBe(false);
      vi.advanceTimersByTime(500);
      expect(document.querySelector(".gw-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bring back a tooltip hidden before its first frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => (frames.push(cb), 0));
    const el = mount("Stage");
    el.dispatchEvent(new Event("mouseenter"));
    el.dispatchEvent(new Event("mouseleave")); // pointer sweeps past in the same frame
    frames.forEach((cb) => cb(0));
    const tip = document.querySelector(".gw-tooltip");
    expect(tip?.classList.contains("gw-tooltip--visible")).toBe(false);
  });

  it("names icon-only anchors, and leaves text or explicit labels alone", () => {
    const icon = mount("Discard");
    expect(icon.getAttribute("aria-label")).toBe("Discard");
    vTooltip.updated(icon, { value: "Delete" });
    expect(icon.getAttribute("aria-label")).toBe("Delete");

    const labelled = document.createElement("button");
    labelled.textContent = "Stage all";
    vTooltip.mounted(labelled, { value: "Stage every file" });
    expect(labelled.hasAttribute("aria-label")).toBe(false);

    const explicit = document.createElement("button");
    explicit.setAttribute("aria-label", "Mine");
    vTooltip.mounted(explicit, { value: "Tip" });
    expect(explicit.getAttribute("aria-label")).toBe("Mine");
  });

  it("gives the name back once an icon-only anchor renders text", () => {
    const el = mount("Laurent G."); // an avatar image…
    expect(el.getAttribute("aria-label")).toBe("Laurent G.");
    el.textContent = "LG"; // …that fell back to initials
    vTooltip.updated(el, { value: "Laurent G." });
    expect(el.hasAttribute("aria-label")).toBe(false);
  });

  it("describes an anchor with its own text by the tooltip while shown, then restores", () => {
    const el = document.createElement("button");
    el.textContent = "+";
    el.setAttribute("aria-describedby", "hint");
    document.body.appendChild(el);
    vTooltip.mounted(el, { value: "Stage" });
    el.dispatchEvent(new Event("focus"));
    const tip = tips()[0] as HTMLElement;
    expect(el.getAttribute("aria-describedby")).toBe(`hint ${tip.id}`);
    el.dispatchEvent(new Event("blur"));
    expect(el.getAttribute("aria-describedby")).toBe("hint");
  });

  it("does not describe an anchor whose name already is the tooltip text", () => {
    const icon = mount("Discard"); // icon-only: the text became its aria-label
    icon.dispatchEvent(new Event("focus"));
    expect(icon.hasAttribute("aria-describedby")).toBe(false);

    const labelled = document.createElement("button");
    labelled.setAttribute("aria-label", "Stash");
    document.body.appendChild(labelled);
    vTooltip.mounted(labelled, { value: "Stash" });
    labelled.dispatchEvent(new Event("focus"));
    expect(labelled.hasAttribute("aria-describedby")).toBe(false);
  });
});
