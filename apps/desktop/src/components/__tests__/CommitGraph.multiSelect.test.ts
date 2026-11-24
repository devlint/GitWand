// @vitest-environment jsdom
/**
 * CommitGraph.vue — multi-selection of commits for the combined diff (v3.15).
 * Cmd-click (mac) / Ctrl-click (others) toggles, Shift-click selects a range,
 * a chip opens the combined diff, Esc clears, the context menu offers it first.
 * Mounted like CommitGraph.stackMenu.test.ts; the real useCommitSelection runs.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
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
});
