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

  it("takes Esc from a non-editable control outside the view (the dock button just clicked)", () => {
    view();
    const dock = document.createElement("nav");
    const btn = document.createElement("button");
    btn.className = "dock-btn";
    dock.appendChild(btn);
    const link = document.createElement("a");
    link.href = "#";
    dock.appendChild(link);
    document.body.appendChild(dock);
    expect(combinedEscAllowed(esc(btn))).toBe(true);
    expect(combinedEscAllowed(esc(link))).toBe(true);
  });

  it("leaves Esc alone: already handled, typed in a field (in or out of the view), under a modal or an open menu", () => {
    const v = view();
    expect(combinedEscAllowed(esc(v.querySelector("button")!, true))).toBe(false);
    const input = document.createElement("input");
    v.appendChild(input);
    expect(combinedEscAllowed(esc(input))).toBe(false);
    const outsideField = document.createElement("textarea");
    document.body.appendChild(outsideField);
    expect(combinedEscAllowed(esc(outsideField))).toBe(false);
    const term = document.createElement("div");
    term.className = "xterm";
    const termInput = document.createElement("div");
    term.appendChild(termInput);
    document.body.appendChild(term);
    expect(combinedEscAllowed(esc(termInput))).toBe(false);
    // A context menu (dock, graph) closes on this Esc; the view stays.
    const menu = document.createElement("ul");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    expect(combinedEscAllowed(esc(document.body))).toBe(false);
    expect(combinedEscAllowed(esc(v.querySelector("button")!))).toBe(false);
    menu.remove();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    expect(combinedEscAllowed(esc(document.body))).toBe(false);
  });
});
