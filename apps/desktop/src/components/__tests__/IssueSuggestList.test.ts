// @vitest-environment jsdom
/**
 * IssueSuggestList (#301, part 4): the rows under `#` in a commit field.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import type { Issue } from "../../utils/backend";
import type { SuggestStatus } from "../../composables/useIssueSuggest";
import IssueSuggestList from "../IssueSuggestList.vue";

vi.mock("../../composables/useI18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

const ISSUE = (n: number, title: string): Issue => ({
  number: n, title, state: "OPEN", author: "a", assignees: [], labels: [], url: "u", createdAt: "x", updatedAt: "y", milestone: "",
});

let app: App | null = null;
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ""; });

async function mount(props: { status: SuggestStatus; rows: Issue[]; active: number; listId?: string }, onPick = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp({ render: () => h(IssueSuggestList, { ...props, onPick }) });
  app.mount(host);
  await nextTick();
  return onPick;
}

describe("IssueSuggestList", () => {
  it("lists #N and title, marks the active row, ends with the hint", async () => {
    await mount({ status: "ready", rows: [ISSUE(42, "Login fails"), ISSUE(57, "Logout")], active: 1 });
    const rows = [...document.querySelectorAll(".isl-row")];
    expect(rows.map((r) => [...r.querySelectorAll("span")].map((x) => x.textContent).join(" "))).toEqual(["#42 Login fails", "#57 Logout"]);
    expect(rows[1].classList.contains("isl-row--active")).toBe(true);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".isl-hint")?.textContent).toContain("sidebar.issueSuggest.hint");
  });

  it("gives the listbox and each row an id for aria-activedescendant", async () => {
    await mount({ status: "ready", rows: [ISSUE(42, "a"), ISSUE(57, "b")], active: 0, listId: "sum-issues" });
    expect(document.querySelector('[role="listbox"]')?.id).toBe("sum-issues");
    expect([...document.querySelectorAll(".isl-row")].map((r) => r.id)).toEqual(["sum-issues-0", "sum-issues-1"]);
  });

  it("says loading, unavailable, or no match", async () => {
    await mount({ status: "loading", rows: [], active: 0 });
    expect(document.body.textContent).toContain("sidebar.issueSuggest.loading");
    app!.unmount(); document.body.innerHTML = "";
    await mount({ status: "error", rows: [], active: 0 });
    expect(document.body.textContent).toContain("sidebar.issueSuggest.unavailable");
    app!.unmount(); document.body.innerHTML = "";
    await mount({ status: "ready", rows: [], active: 0 });
    expect(document.body.textContent).toContain("sidebar.issueSuggest.empty");
  });

  it("a click picks without taking the focus; shift-click picks Fixes", async () => {
    const onPick = await mount({ status: "ready", rows: [ISSUE(42, "a"), ISSUE(57, "b")], active: 0 });
    const row = document.querySelectorAll<HTMLElement>(".isl-row")[1];
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    row.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenLastCalledWith(1, false);
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true }));
    expect(onPick).toHaveBeenLastCalledWith(1, true);
  });
});
