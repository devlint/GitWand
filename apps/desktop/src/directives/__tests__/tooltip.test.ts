// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { vTooltip } from "../tooltip";

type Binding = { value: unknown; oldValue: unknown };

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
    for (let i = 0; i < 5; i++) vTooltip.updated(el, { value: `v${i}`, oldValue: i ? `v${i - 1}` : "a" } as Binding);
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
    vTooltip.updated(el, { value: "late", oldValue: "" });
    el.dispatchEvent(new Event("mouseenter"));
    expect(tips()).toEqual(["late"]);
  });

  it("updates a visible tooltip's text, and removes it when the text goes away", () => {
    const el = anchor();
    vTooltip.mounted(el, { value: "one" });
    el.dispatchEvent(new Event("mouseenter"));
    vTooltip.updated(el, { value: "two", oldValue: "one" });
    expect(tips()).toEqual(["two"]);
    vTooltip.updated(el, { value: "", oldValue: "two" });
    expect(tips()).toEqual([]);
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
    vTooltip.updated(icon, { value: "Delete", oldValue: "Discard" });
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
