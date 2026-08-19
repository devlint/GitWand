/**
 * v3.7.0 review-round fix (finding #11) — pure focus-trap arithmetic, unit
 * tested without mounting a component. `BaseModal.vue` stays thin: it just
 * calls `focusableWithin`/`nextTrapTarget` from its `Tab` handler.
 */
import { describe, it, expect } from "vitest";
import { focusableWithin, nextTrapTarget } from "../focusTrap";

function makeRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("focusableWithin", () => {
  it("finds buttons, links-with-href, inputs, selects, textareas, and [tabindex='0'] in DOM order", () => {
    const root = makeRoot(`
      <button id="b1">one</button>
      <a href="/x" id="a1">link</a>
      <input id="i1" />
      <select id="s1"><option>x</option></select>
      <textarea id="t1"></textarea>
      <div tabindex="0" id="d1">focusable div</div>
    `);
    const found = focusableWithin(root).map((el) => el.id);
    expect(found).toEqual(["b1", "a1", "i1", "s1", "t1", "d1"]);
    root.remove();
  });

  it("excludes disabled elements", () => {
    const root = makeRoot(`<button id="b1">a</button><button id="b2" disabled>b</button>`);
    expect(focusableWithin(root).map((el) => el.id)).toEqual(["b1"]);
    root.remove();
  });

  it("excludes tabindex='-1' elements", () => {
    const root = makeRoot(`<button id="b1">a</button><button id="b2" tabindex="-1">b</button>`);
    expect(focusableWithin(root).map((el) => el.id)).toEqual(["b1"]);
    root.remove();
  });

  it("excludes hidden elements", () => {
    const root = makeRoot(`<button id="b1">a</button><button id="b2" hidden>b</button>`);
    expect(focusableWithin(root).map((el) => el.id)).toEqual(["b1"]);
    root.remove();
  });

  it("excludes aria-hidden='true' elements", () => {
    const root = makeRoot(`<button id="b1">a</button><button id="b2" aria-hidden="true">b</button>`);
    expect(focusableWithin(root).map((el) => el.id)).toEqual(["b1"]);
    root.remove();
  });

  it("excludes an a without href", () => {
    const root = makeRoot(`<button id="b1">a</button><a id="a1">no href</a>`);
    expect(focusableWithin(root).map((el) => el.id)).toEqual(["b1"]);
    root.remove();
  });

  it("returns [] for a root with no focusable descendants", () => {
    const root = makeRoot(`<div>just text</div>`);
    expect(focusableWithin(root)).toEqual([]);
    root.remove();
  });
});

describe("nextTrapTarget", () => {
  it("wraps from the last focusable to the first when moving forward", () => {
    const root = makeRoot(`<button id="b1"></button><button id="b2"></button><button id="b3"></button>`);
    const focusables = focusableWithin(root);
    const last = focusables[focusables.length - 1];
    expect(nextTrapTarget(focusables, last, false)).toBe(focusables[0]);
    root.remove();
  });

  it("wraps from the first focusable to the last when moving backward (Shift+Tab)", () => {
    const root = makeRoot(`<button id="b1"></button><button id="b2"></button><button id="b3"></button>`);
    const focusables = focusableWithin(root);
    const first = focusables[0];
    expect(nextTrapTarget(focusables, first, true)).toBe(focusables[focusables.length - 1]);
    root.remove();
  });

  it("returns the first element when the active element is outside the focusable set (forward)", () => {
    const root = makeRoot(`<button id="b1"></button><button id="b2"></button>`);
    const focusables = focusableWithin(root);
    const outside = document.createElement("div");
    expect(nextTrapTarget(focusables, outside, false)).toBe(focusables[0]);
    root.remove();
  });

  it("returns the last element when the active element is outside the focusable set (backward)", () => {
    const root = makeRoot(`<button id="b1"></button><button id="b2"></button>`);
    const focusables = focusableWithin(root);
    const outside = document.createElement("div");
    expect(nextTrapTarget(focusables, outside, true)).toBe(focusables[focusables.length - 1]);
    root.remove();
  });

  it("returns null for an empty focusable set", () => {
    expect(nextTrapTarget([], null, false)).toBeNull();
    expect(nextTrapTarget([], null, true)).toBeNull();
  });

  it("returns null for a middle element (not a wrap boundary) — the browser's default Tab handles it, the trap must not interfere", () => {
    const root = makeRoot(`<button id="b1"></button><button id="b2"></button><button id="b3"></button>`);
    const focusables = focusableWithin(root);
    expect(nextTrapTarget(focusables, focusables[1], false)).toBeNull();
    expect(nextTrapTarget(focusables, focusables[1], true)).toBeNull();
    root.remove();
  });
});
