// @vitest-environment jsdom
/**
 * CommitGraph.vue — multi-selection of commits for the combined diff (v3.15).
 * Cmd-click (mac) / Ctrl-click (others) toggles, Shift-click selects a range,
 * a chip opens the combined diff, Esc clears, the context menu offers it first.
 * Mounted like CommitGraph.stackMenu.test.ts; the real useCommitSelection runs.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, shallowRef, type App } from "vue";
import CommitGraph from "../CommitGraph.vue";
import type { GitLogEntry } from "../../utils/backend";
import { useCommitSelection } from "../../composables/useCommitSelection";
import { ref } from "vue";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

// IS_MAC is a load-time constant: expose it as a switch for the mac cases.
const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("../../utils/platform", async (orig) => {
  const actual = await orig<typeof import("../../utils/platform")>();
  return {
    ...actual,
    isToggleModifier: (e: { metaKey: boolean; ctrlKey: boolean }) => (platform.mac ? e.metaKey : e.ctrlKey),
  };
});

const full = (h: string) => h.padEnd(40, "0");
const names = ["aaa1111", "bbb2222", "ccc3333", "ddd4444", "eee5555"];
const entry = (hash: string, i: number): GitLogEntry => ({
  hash,
  hashFull: full(hash),
  author: "Dev",
  email: "dev@example.com",
  date: "2026-08-01T00:00:00Z",
  message: `commit ${hash}`,
  body: "",
  parents: i < names.length - 1 ? [full(names[i + 1])] : [],
  refs: i === 0 ? "HEAD -> main" : "",
});
const commits = names.map(entry);

let app: App | null = null;
let container: HTMLElement | null = null;
let n = 0;
let cwd = "";

function mount(over: Record<string, unknown> = {}) {
  cwd = `/repo/multi-${n++}`;
  container = document.createElement("div");
  document.body.appendChild(container);
  const emitted: Record<string, unknown[][]> = {};
  const on = (name: string) => (...a: unknown[]) => {
    (emitted[name] ??= []).push(a);
  };
  app = createApp({
    setup: () => () =>
      h(CommitGraph, {
        commits,
        currentBranch: "main",
        cwd,
        selectedHash: full("aaa1111"),
        onSelectCommit: on("select-commit"),
        onOpenCombined: on("open-combined"),
        ...over,
      }),
  });
  app.mount(container);
  return { emitted };
}

afterEach(() => {
  useCommitSelection(ref(cwd)).clear();
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  platform.mac = false;
});

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".cg-row"));
const chip = () => document.querySelector<HTMLElement>(".cg-multi-chip");
async function click(i: number, init: MouseEventInit = {}) {
  await nextTick();
  rows()[i].dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  await nextTick();
}
const asMac = () => {
  platform.mac = true;
};

describe("CommitGraph — multi-selection", () => {
  it("Ctrl-click (non-mac) toggles without emitting select-commit; the current commit seeds", async () => {
    const { emitted } = mount();
    await click(2, { ctrlKey: true });
    expect(emitted["select-commit"]).toBeUndefined();
    expect(rows().filter((r) => r.classList.contains("cg-row--multi"))).toHaveLength(2);
    expect(chip()?.textContent).toContain("combined.chip:2");
  });

  it("on mac, Cmd-click toggles and Ctrl-click does not", async () => {
    asMac();
    const { emitted } = mount();
    await click(2, { ctrlKey: true });
    expect(emitted["select-commit"]).toHaveLength(1);
    await click(2, { metaKey: true });
    expect(emitted["select-commit"]).toHaveLength(1);
    expect(chip()).not.toBeNull();
  });

  it("Shift-click selects the rows between the anchor and the clicked row", async () => {
    const { emitted } = mount();
    await click(1, { shiftKey: true });
    await click(3, { shiftKey: true });
    expect(emitted["select-commit"]).toBeUndefined();
    const multi = rows().map((r) => r.classList.contains("cg-row--multi"));
    expect(multi).toEqual([true, true, true, true, false]);
  });

  it("the chip opens the combined diff with row-ordered hashes (whatever the click order)", async () => {
    const { emitted } = mount();
    await click(3, { ctrlKey: true });
    await click(1, { ctrlKey: true });
    chip()!.querySelector<HTMLElement>(".cg-multi-chip__open")!.click();
    expect(emitted["open-combined"]).toEqual([[[full("aaa1111"), full("bbb2222"), full("ddd4444")]]]);
  });

  it("Enter opens it too; Esc clears, plain click resets and selects", async () => {
    const { emitted } = mount();
    await click(1, { ctrlKey: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(emitted["open-combined"]).toHaveLength(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(chip()).toBeNull();
    await click(1, { ctrlKey: true });
    expect(chip()).not.toBeNull();
    await click(4);
    expect(chip()).toBeNull();
    expect(emitted["select-commit"]).toEqual([[full("eee5555")]]);
  });

  it("the chip's clear button empties the selection", async () => {
    mount();
    await click(1, { ctrlKey: true });
    chip()!.querySelector<HTMLElement>(".cg-multi-chip__clear")!.click();
    await nextTick();
    expect(chip()).toBeNull();
  });

  it("over 50 commits the chip shows the limit and the action is disabled", async () => {
    const many = Array.from({ length: 52 }, (_, i) => entry(`x${String(i).padStart(6, "0")}`, 0));
    const { emitted } = mount({ commits: many, selectedHash: many[0].hashFull });
    const sel = useCommitSelection(ref(cwd));
    sel.toggle(many[0].hashFull, null);
    sel.range(many[51].hashFull, many.map((m) => m.hashFull));
    await nextTick();
    expect(chip()?.textContent).toContain("combined.tooMany:50");
    const open = chip()!.querySelector<HTMLButtonElement>(".cg-multi-chip__open")!;
    expect(open.disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(emitted["open-combined"]).toBeUndefined();
  });

  it("context menu on a multi-selected row lists the combined diff first", async () => {
    const { emitted } = mount();
    await click(1, { ctrlKey: true });
    rows()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await nextTick();
    const first = document.querySelector<HTMLElement>(".commit-ctx-menu-item");
    expect(first?.textContent).toContain("combined.ctxOpen:2");
    first!.click();
    expect(emitted["open-combined"]).toEqual([[[full("aaa1111"), full("bbb2222")]]]);
    expect(emitted["select-commit"]).toBeUndefined();
  });

  it("context menu on a single row has no combined entry", async () => {
    mount();
    await nextTick();
    rows()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await nextTick();
    expect(document.querySelector(".commit-ctx-menu")?.textContent).not.toContain("combined.ctxOpen");
  });

  it("context menu on a row outside the multi-selection keeps the selection", async () => {
    const { emitted } = mount();
    await click(1, { ctrlKey: true });
    expect(chip()?.textContent).toContain("combined.chip:2");
    rows()[3].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await nextTick();
    expect(useCommitSelection(ref(cwd)).selected.value).toEqual([full("aaa1111"), full("bbb2222")]);
    expect(chip()?.textContent).toContain("combined.chip:2");
    expect(emitted["select-commit"]).toBeUndefined();
    // The menu acts on the right-clicked row, with no combined entry.
    expect(document.querySelector(".commit-ctx-menu")?.textContent).not.toContain("combined.ctxOpen");
  });

  it("a reload that drops a selected commit prunes it", async () => {
    const log = shallowRef(commits);
    const { emitted } = mount();
    app!.unmount();
    container!.remove();
    // remount with a reactive log so the same instance sees the reload
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({
      setup: () => () =>
        h(CommitGraph, { commits: log.value, cwd, selectedHash: full("aaa1111"), onOpenCombined: (hs: string[]) => (emitted["open-combined"] ??= []).push([hs]) }),
    });
    app.mount(container);
    await click(1, { ctrlKey: true });
    await click(2, { ctrlKey: true });
    expect(chip()?.textContent).toContain("combined.chip:3");
    log.value = commits.filter((c) => c.hash !== "ccc3333");
    await nextTick();
    await nextTick();
    expect(chip()?.textContent).toContain("combined.chip:2");
    chip()!.querySelector<HTMLElement>(".cg-multi-chip__open")!.click();
    expect(emitted["open-combined"][0][0]).toEqual([full("aaa1111"), full("bbb2222")]);
    expect(useCommitSelection(ref(cwd)).selected.value).toEqual([full("aaa1111"), full("bbb2222")]);
  });

  /** Mount on a reactive log + hasMore so one instance sees the reloads. */
  function mountReactive(log: { value: GitLogEntry[] }, more: { value: boolean }) {
    cwd = `/repo/multi-${n++}`;
    container = document.createElement("div");
    document.body.appendChild(container);
    const emitted: Record<string, unknown[][]> = {};
    app = createApp({
      setup: () => () =>
        h(CommitGraph, {
          commits: log.value,
          hasMore: more.value,
          cwd,
          selectedHash: full("aaa1111"),
          onOpenCombined: (hs: string[]) => (emitted["open-combined"] ??= []).push([hs]),
        }),
    });
    app.mount(container);
    return { emitted };
  }

  it("a shorter reload with more pages keeps a selected commit beyond the loaded depth", async () => {
    const log = shallowRef(commits);
    const more = ref(false);
    const { emitted } = mountReactive(log, more);
    await click(3, { ctrlKey: true }); // seeds aaa, adds ddd
    await click(1, { ctrlKey: true }); // bbb
    expect(chip()?.textContent).toContain("combined.chip:3");
    more.value = true;
    log.value = commits.slice(0, 3); // ddd now lies beyond the loaded depth
    await nextTick();
    await nextTick();
    expect(useCommitSelection(ref(cwd)).selected.value).toContain(full("ddd4444"));
    expect(chip()?.textContent).toContain("combined.chip:3");
    chip()!.querySelector<HTMLElement>(".cg-multi-chip__open")!.click();
    // Loaded ones in log order, then the unloaded one in selection order.
    expect(emitted["open-combined"][0][0]).toEqual([full("aaa1111"), full("bbb2222"), full("ddd4444")]);
  });

  it("a complete log without a selected commit prunes it", async () => {
    const log = shallowRef(commits);
    const more = ref(true);
    mountReactive(log, more);
    await click(3, { ctrlKey: true });
    await click(1, { ctrlKey: true });
    log.value = commits.slice(0, 3);
    await nextTick();
    await nextTick();
    expect(useCommitSelection(ref(cwd)).selected.value).toContain(full("ddd4444"));
    more.value = false; // the last page came in: ddd is really gone
    await nextTick();
    await nextTick();
    expect(useCommitSelection(ref(cwd)).selected.value).toEqual([full("aaa1111"), full("bbb2222")]);
    expect(chip()?.textContent).toContain("combined.chip:2");
  });

  /** Mount on a reactive log + filter props (complete log: hasMore false). */
  function mountFiltered(log: { value: GitLogEntry[] }, filters: { value: Record<string, unknown> }) {
    cwd = `/repo/multi-${n++}`;
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({
      setup: () => () =>
        h(CommitGraph, { commits: log.value, hasMore: false, cwd, selectedHash: full("aaa1111"), ...filters.value }),
    });
    app.mount(container);
  }

  for (const [label, filter] of [
    ["branch", { logBranchFilter: "current" }],
    ["author", { logAuthorFilter: "mine" }],
  ] as const) {
    it(`a complete log narrowed by the ${label} filter keeps a selected commit it hides`, async () => {
      const log = shallowRef(commits);
      const filters = shallowRef<Record<string, unknown>>({ logBranchFilter: "all", logAuthorFilter: "all" });
      mountFiltered(log, filters);
      await click(3, { ctrlKey: true });
      await click(1, { ctrlKey: true });
      filters.value = { logBranchFilter: "all", logAuthorFilter: "all", ...filter };
      log.value = commits.slice(0, 3);
      await nextTick();
      await nextTick();
      expect(useCommitSelection(ref(cwd)).selected.value).toContain(full("ddd4444"));
      expect(chip()?.textContent).toContain("combined.chip:3");
      // Back to "all": the filtered log is still shown until the reload lands.
      filters.value = { logBranchFilter: "all", logAuthorFilter: "all" };
      await nextTick();
      await nextTick();
      expect(useCommitSelection(ref(cwd)).selected.value).toContain(full("ddd4444"));
      log.value = commits;
      await nextTick();
      expect(useCommitSelection(ref(cwd)).selected.value).toContain(full("ddd4444"));
    });
  }

  it("a complete log narrowed by a monorepo scope keeps a selected commit it hides", async () => {
    const { useWorkspaceScope } = await import("../../composables/useWorkspaceScope");
    const log = shallowRef(commits);
    const filters = shallowRef<Record<string, unknown>>({});
    mountFiltered(log, filters);
    await click(3, { ctrlKey: true });
    await click(1, { ctrlKey: true });
    const scope = useWorkspaceScope().activeScope;
    scope.value = "packages/core";
    try {
      log.value = commits.slice(0, 3);
      await nextTick();
      await nextTick();
      expect(useCommitSelection(ref(cwd)).selected.value).toContain(full("ddd4444"));
    } finally {
      scope.value = null;
    }
  });

  it("a transient empty log (reload) keeps the selection", async () => {
    const log = shallowRef(commits);
    app = null;
    cwd = `/repo/multi-${n++}`;
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({ setup: () => () => h(CommitGraph, { commits: log.value, cwd, selectedHash: full("aaa1111") }) });
    app.mount(container);
    await click(1, { ctrlKey: true });
    expect(chip()?.textContent).toContain("combined.chip:2");
    log.value = [];
    await nextTick();
    log.value = commits;
    await nextTick();
    await nextTick();
    expect(useCommitSelection(ref(cwd)).selected.value).toEqual([full("aaa1111"), full("bbb2222")]);
  });

  it("Cmd/Ctrl- or Shift-click on a stash row leaves the multi-selection alone", async () => {
    const withStash = [...commits.slice(0, 4), { ...commits[4], refs: "refs/stash" }];
    const { emitted } = mount({ commits: withStash });
    await click(1, { ctrlKey: true });
    await click(2, { ctrlKey: true });
    expect(chip()?.textContent).toContain("combined.chip:3");
    await click(4, { ctrlKey: true });
    await click(4, { shiftKey: true });
    expect(emitted["select-commit"]).toBeUndefined();
    expect(chip()?.textContent).toContain("combined.chip:3");
  });

  it("Shift-press on a row does not start a text selection", async () => {
    mount();
    await nextTick();
    const press = (shiftKey: boolean) => {
      const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey });
      rows()[2].dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(press(true)).toBe(true);
    expect(press(false)).toBe(false);
  });

  it("a search that hides a selected row keeps it counted and emitted", async () => {
    const { emitted } = mount();
    await click(1, { ctrlKey: true });
    await click(2, { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>(".cg-search-input")!;
    input.value = "ddd4444";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(chip()?.textContent).toContain("combined.chip:3");
    chip()!.querySelector<HTMLElement>(".cg-multi-chip__open")!.click();
    expect(emitted["open-combined"][0][0]).toEqual([full("aaa1111"), full("bbb2222"), full("ccc3333")]);
  });

  it("Esc and Enter typed in the search box leave the selection alone", async () => {
    const { emitted } = mount();
    await click(1, { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>(".cg-search-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(chip()).not.toBeNull();
    expect(emitted["open-combined"]).toBeUndefined();
  });

  it("Enter on a control outside the graph, or under a modal, does not open it", async () => {
    const { emitted } = mount();
    await click(1, { ctrlKey: true });
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(emitted["open-combined"]).toBeUndefined();
    expect(chip()).not.toBeNull();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(chip()).not.toBeNull();
    modal.remove();
    outside.remove();
  });

  it("a jump to a commit from the combined view (App sets the anchor) drives the next Shift-click", async () => {
    mount({ selectedHash: full("ddd4444") });
    await nextTick();
    // App.vue `onCombinedSelectCommit`: the anchor follows the jumped-to commit.
    useCommitSelection(ref(cwd)).setAnchor(full("ddd4444"));
    await click(1, { shiftKey: true });
    const multi = rows().map((r) => r.classList.contains("cg-row--multi"));
    expect(multi).toEqual([false, true, true, true, false]);
  });

  it("click, shift, cmd, shift keeps following the last anchor", async () => {
    mount({ selectedHash: full("bbb2222") });
    await click(1);
    await click(3, { shiftKey: true });
    await click(4, { ctrlKey: true });
    await click(2, { shiftKey: true });
    const multi = rows().map((r) => r.classList.contains("cg-row--multi"));
    expect(multi).toEqual([false, false, true, true, true]);
  });
});
