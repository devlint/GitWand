// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { vTooltip } from "../tooltip";

function tips() {
  return [...document.querySelectorAll(".gw-tooltip")].map((t) => t.textContent);
}

function anchor(text = "") {
  const el = document.createElement("button");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("v-tooltip", () => {
  it("shows one tooltip with the latest text after many updates", () => {
    const el = anchor();
    vTooltip.mounted(el, { value: "a" });
    for (let i = 0; i < 5; i++) vTooltip.updated(el, { value: `v${i}` });
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toEqual(["v4"]);
    el.dispatchEvent(new Event("mouseleave"));
    expect(tips()).toEqual([]);
  });

  it("starts working when its text arrives after mount", () => {
    const el = anchor();
    vTooltip.mounted(el, { value: "" });
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toEqual([]);
    vTooltip.updated(el, { value: "late" });
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toEqual(["late"]);
  });

  it("updates a visible tooltip's text, and removes it when the text goes away", () => {
    const el = anchor();
    vTooltip.mounted(el, { value: "one" });
    el.dispatchEvent(new Event("mouseenter"));
    vTooltip.updated(el, { value: "two" });
    expect(tips()).toEqual(["two"]);
    vTooltip.updated(el, { value: "" });
    expect(tips()).toEqual([]);
  });

  it("keeps a visible tooltip in place when an object binding re-renders unchanged", () => {
    const el = anchor();
    vTooltip.mounted(el, { value: { text: "Terminal", position: "right" } });
    el.dispatchEvent(new Event("mouseenter"));
    const before = document.querySelector(".gw-tooltip");
    vTooltip.updated(el, { value: { text: "Terminal", position: "right" } });
    expect(document.querySelector(".gw-tooltip")).toBe(before);
  });

  it("stops listening once unmounted", () => {
    const el = anchor();
    vTooltip.mounted(el, { value: "x" });
    vTooltip.beforeUnmount(el);
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toEqual([]);
  });

  it("names icon-only anchors, and leaves text or explicit labels alone", () => {
    const icon = anchor();
    vTooltip.mounted(icon, { value: "Discard" });
    expect(icon.getAttribute("aria-label")).toBe("Discard");
    vTooltip.updated(icon, { value: "Delete" });
    expect(icon.getAttribute("aria-label")).toBe("Delete");

    const labelled = anchor("Stage all");
    vTooltip.mounted(labelled, { value: "Stage every file" });
    expect(labelled.hasAttribute("aria-label")).toBe(false);

    const explicit = anchor();
    explicit.setAttribute("aria-label", "Mine");
    vTooltip.mounted(explicit, { value: "Tip" });
    expect(explicit.getAttribute("aria-label")).toBe("Mine");
  });
});
