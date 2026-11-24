// @vitest-environment jsdom
/**
 * App's Escape ladder (`onGlobalKeydown`): which overlay one Esc closes, and
 * when the combined diff view may take it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { escLayer, combinedEscAllowed } from "../combinedEsc";

afterEach(() => { document.body.innerHTML = ""; });

const esc = (target: EventTarget, prevented = false) => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  if (prevented) e.preventDefault();
  let seen: KeyboardEvent | null = null;
  const grab = (ev: Event) => { seen = ev as KeyboardEvent; };
  window.addEventListener("keydown", grab);
  target.dispatchEvent(e);
  window.removeEventListener("keydown", grab);
  return seen!;
};

function view(): HTMLElement {
  const v = document.createElement("div");
  v.className = "cmb";
  v.appendChild(document.createElement("button"));
  document.body.appendChild(v);
  return v;
}

describe("escLayer", () => {
  it("closes one thing, topmost first: panels before the combined view", () => {
    const all = { commandLog: true, help: true, switchStash: true, stash: true, combined: true };
    expect(escLayer(all)).toBe("commandLog");
    expect(escLayer({ ...all, commandLog: false })).toBe("help");
    expect(escLayer({ ...all, commandLog: false, help: false })).toBe("switchStash");
    expect(escLayer({ combined: true, stash: true })).toBe("stash");
    expect(escLayer({ combined: true })).toBe("combined");
    expect(escLayer({})).toBeNull();
  });
});

describe("combinedEscAllowed", () => {
  it("is false when the view is not on screen", () => {
    expect(combinedEscAllowed(esc(document.body))).toBe(false);
  });

  it("takes Esc from the bare page and from inside the view", () => {
    const v = view();
    expect(combinedEscAllowed(esc(document))).toBe(true);
    expect(combinedEscAllowed(esc(document.documentElement))).toBe(true);
    expect(combinedEscAllowed(esc(document.body))).toBe(true);
    expect(combinedEscAllowed(esc(v.querySelector("button")!))).toBe(true);
  });

  it("leaves Esc alone: already handled, typed in a field, outside the view, under a modal", () => {
    const v = view();
    expect(combinedEscAllowed(esc(v.querySelector("button")!, true))).toBe(false);
    const input = document.createElement("input");
    v.appendChild(input);
    expect(combinedEscAllowed(esc(input))).toBe(false);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    expect(combinedEscAllowed(esc(outside))).toBe(false);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    expect(combinedEscAllowed(esc(document.body))).toBe(false);
  });
});
