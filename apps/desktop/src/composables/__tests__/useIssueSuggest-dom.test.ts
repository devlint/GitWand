// @vitest-environment jsdom
/**
 * useIssueSuggest on real fields (#301, part 4): the key wiring RepoSidebar uses.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { nextTick } from "vue";
import type { Issue } from "../../utils/backend";
import { useIssueSuggest, handleIssueKeydown, refreshIssueSuggest } from "../useIssueSuggest";

const ISSUES: Issue[] = [
  { number: 42, title: "Login fails", state: "OPEN", author: "a", assignees: [], labels: [], url: "https://github.com/me/app/issues/42", createdAt: "x", updatedAt: "2026-11-10", milestone: "" },
];
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

afterEach(() => { document.body.innerHTML = ""; });

async function field(tag: "input" | "textarea", value: string) {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  el.value = value;
  el.focus();
  el.setSelectionRange(value.length, value.length);
  const s = useIssueSuggest({ cwd: () => "/r", loadIssues: async () => ISSUES, pushRepo: () => "me/app" });
  refreshIssueSuggest(s, el);
  await flush();
  const written: string[] = [];
  const write = (t: string) => { written.push(t); el.value = t; };
  el.addEventListener("keydown", (e) => handleIssueKeydown(s, e as KeyboardEvent, el, write));
  return { el, s, written };
}

const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

describe("handleIssueKeydown", () => {
  it("Enter writes #N and puts the caret after it", async () => {
    const { el, written } = await field("input", "Fix #42");
    const e = press(el, "Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(written).toEqual(["Fix #42 "]);
    await nextTick();
    expect(el.selectionStart).toBe(8);
  });

  it("Shift+Enter in a textarea writes Fixes #N", async () => {
    const { el, written } = await field("textarea", "line\n#42");
    press(el, "Enter", { shiftKey: true });
    expect(written).toEqual(["line\nFixes #42 "]);
  });

  it("Escape closes the list without reaching a window Escape listener", async () => {
    const { el, s } = await field("input", "#");
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    const e = press(el, "Escape");
    window.removeEventListener("keydown", seen);
    expect(e.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(s.open.value).toBe(false);
  });

  it("Cmd+Enter is left alone while the list is open", async () => {
    const { el, written, s } = await field("input", "#");
    const e = press(el, "Enter", { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(written).toEqual([]);
    expect(s.open.value).toBe(true);
  });

  it("a caret moved without a refresh (Cmd+Right, PageDown) lets Enter through", async () => {
    const { el, written, s } = await field("textarea", "see #4");
    el.setSelectionRange(0, 0);
    const e = press(el, "Enter");
    expect(e.defaultPrevented).toBe(false);
    expect(written).toEqual([]);
    expect(s.open.value).toBe(false);
  });

  it("an Escape with the list closed reaches the window", async () => {
    const { el } = await field("input", "plain");
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    press(el, "Escape");
    window.removeEventListener("keydown", seen);
    expect(seen).toHaveBeenCalled();
  });
});
