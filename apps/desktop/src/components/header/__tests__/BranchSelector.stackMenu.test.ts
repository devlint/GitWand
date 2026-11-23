// @vitest-environment jsdom
/**
 * BranchSelector — right-click on a local or pinned branch row opens the
 * stack context menu (QA bug 1): "Stack on…" asks the shared StackOnHost to
 * open, "Unstack" and "Restack…" run through useStackActions. The IPC
 * wrappers the popover calls on open are faked; the stacks store is a fake
 * installed with __setStacksForTest.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";

vi.mock("../../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));
vi.mock("../../../utils/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/backend")>()),
  gitSubmoduleList: vi.fn(async () => []),
  gitSubmoduleBranches: vi.fn(async () => []),
  getGitLog: vi.fn(async () => []),
  getGitBranchTopAuthors: vi.fn(async () => []),
}));

import BranchSelector from "../BranchSelector.vue";
import { PR_PANEL_KEY } from "../../../composables/usePrPanel";
import { __setStacksForTest, type Stacks } from "../../../composables/useStacks";
import { useStackActions } from "../../../composables/useStackActions";
import type { GitBranch, StackLayerStatus } from "../../../utils/backend";

const branch = (name: string, isCurrent = false, isRemote = false): GitBranch => ({
  name,
  isCurrent,
  isRemote,
  upstream: null,
  ahead: 0,
  behind: 0,
  mainCommitCount: 1,
  lastCommit: "abc",
  lastCommitDate: "2026-08-01T00:00:00Z",
});

const layer = { branch: "step-2" } as StackLayerStatus;
let unstack: ReturnType<typeof vi.fn>;
let startRestack: ReturnType<typeof vi.fn>;

let app: App | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  unstack = vi.fn(async () => {});
  startRestack = vi.fn(async () => {});
  __setStacksForTest({
    report: ref({ trunk: "main" }),
    trunk: () => "main",
    offers: ref(new Map()),
    layerOf: (b: string) => (b === "step-2" ? layer : null),
    actionableFor: (b: string) => (b === "step-2" ? layer : null),
    dismissBridge: vi.fn(),
    unstack,
    startRestack,
  } as unknown as Stacks);
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  useStackActions().closeStackOn();
  __setStacksForTest(null);
});

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
};

let switched: string[] = [];

async function mountOpen() {
  switched = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(BranchSelector, {
        branchDisplay: "main",
        repoStats: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, added: 0, modified: 0, deleted: 0, renamed: 0 },
        branches: [branch("main", true), branch("step-2"), branch("feature"), branch("origin/feature", false, true)],
        branchesLoading: false,
        isSwitchingBranch: false,
        cwd: "/r",
        onSwitchBranch: (name: string) => switched.push(name),
      }),
  });
  app.provide(PR_PANEL_KEY, { prs: ref([]), forge: ref(null), ensurePrsLoaded: async () => {} } as never);
  app.directive("tooltip", {});
  app.mount(container);
  document.querySelector<HTMLButtonElement>(".branch-trigger")!.click();
  await flush();
}

function row(name: string): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>(".bp-item")).find(
    (li) => li.querySelector(".bp-item-name")?.getAttribute("title") === name,
  );
  if (!el) throw new Error(`row "${name}" not found`);
  return el;
}

async function rightClick(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
  await flush();
}

const menuItems = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".stack-branch-menu .ctx-item")).map((b) => b.textContent?.trim());

describe("BranchSelector — stack context menu", () => {
  it("right-click on a stacked local row opens the menu with the three stack items", async () => {
    await mountOpen();
    await rightClick(row("step-2"));
    await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
    expect(menuItems()).toEqual(["stacks.menu.stackOn", "stacks.menu.unstack", "stacks.menu.restack"]);
  });

  it("Stack on… requests the shared dialog and closes the menu", async () => {
    await mountOpen();
    await rightClick(row("feature"));
    await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
    expect(menuItems()).toEqual(["stacks.menu.stackOn"]);
    document.querySelector<HTMLButtonElement>(".stack-branch-menu .ctx-item")!.click();
    await flush();
    expect(useStackActions().stackOnRequest.value).toEqual({ cwd: "/r", branch: "feature" });
    expect(document.querySelector(".stack-branch-menu")).toBeNull();
  });

  it("Unstack and Restack… run the stack actions on the row's branch", async () => {
    await mountOpen();
    await rightClick(row("step-2"));
    await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
    Array.from(document.querySelectorAll<HTMLButtonElement>(".stack-branch-menu .ctx-item"))[1].click();
    await flush();
    expect(unstack).toHaveBeenCalledWith("/r", "step-2");

    document.querySelector<HTMLButtonElement>(".branch-trigger")!.click();
    await flush();
    await rightClick(row("step-2"));
    await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
    Array.from(document.querySelectorAll<HTMLButtonElement>(".stack-branch-menu .ctx-item"))[2].click();
    await flush();
    expect(startRestack).toHaveBeenCalledWith("/r", "step-2");
  });

  it("opens nothing on the trunk row, which has no stack item", async () => {
    await mountOpen();
    await rightClick(row("main"));
    expect(document.querySelector(".stack-branch-menu")).toBeNull();
  });

  it("Escape and an outside click close the menu", async () => {
    await mountOpen();
    await rightClick(row("step-2"));
    await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(document.querySelector(".stack-branch-menu")).toBeNull();

    await rightClick(row("step-2"));
    await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector(".stack-branch-menu")).toBeNull();
  });
});

const popoverOpen = () => document.querySelector(".branch-popover") !== null;
async function openMenu(name: string) {
  await rightClick(row(name));
  await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
  await flush();
}

describe("BranchSelector — stack menu, QA2", () => {
  it("a pinned row's right-click opens the menu too (item 4)", async () => {
    const { usePinnedBranches } = await import("../../../composables/usePinnedBranches");
    const pins = usePinnedBranches(() => "/r");
    pins.pin("step-2");
    try {
      await mountOpen();
      const pinnedRow = document.querySelector<HTMLElement>('.bp-section .bp-item');
      expect(pinnedRow?.querySelector(".bp-item-name")?.getAttribute("title")).toBe("step-2");
      await rightClick(pinnedRow!);
      await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
      expect(menuItems()).toEqual(["stacks.menu.stackOn", "stacks.menu.unstack", "stacks.menu.restack"]);
    } finally {
      pins.unpin("step-2");
    }
  });

  it("a left-click on a row still switches branch (item 4)", async () => {
    await mountOpen();
    row("feature").click();
    await flush();
    expect(switched).toEqual(["feature"]);
    expect(document.querySelector(".stack-branch-menu")).toBeNull();
  });

  it("running an item closes the branch popover (item 6)", async () => {
    await mountOpen();
    await openMenu("step-2");
    expect(popoverOpen()).toBe(true);
    Array.from(document.querySelectorAll<HTMLButtonElement>(".stack-branch-menu .ctx-item"))[1].click();
    await flush();
    expect(popoverOpen()).toBe(false);
  });

  it("is clamped inside the window (item 1)", async () => {
    const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const hgt = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 240 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 120 });
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    window.innerWidth = 1400;
    window.innerHeight = 800;
    try {
      await mountOpen();
      row("step-2").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1350, clientY: 760 }),
      );
      await vi.waitFor(() => expect(document.querySelector(".stack-branch-menu")).not.toBeNull());
      await flush();
      const menu = document.querySelector<HTMLElement>(".stack-branch-menu")!;
      expect(menu.style.left).toBe(`${1400 - 240 - 4}px`);
      expect(menu.style.top).toBe(`${800 - 120 - 4}px`);
    } finally {
      if (w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", w);
      if (hgt) Object.defineProperty(HTMLElement.prototype, "offsetHeight", hgt);
      window.innerWidth = iw;
      window.innerHeight = ih;
    }
  });

  it("focuses the first item, moves with the arrow keys, and Escape gives focus back (item 5)", async () => {
    await mountOpen();
    const filter = document.querySelector<HTMLInputElement>(".bp-filter")!;
    filter.focus();
    await openMenu("step-2");
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".stack-branch-menu .ctx-item"));
    expect(document.activeElement).toBe(items[0]);
    const key = (k: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key("ArrowUp");
    key("ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    key("Escape");
    await flush();
    expect(document.querySelector(".stack-branch-menu")).toBeNull();
    expect(document.activeElement).toBe(filter);
  });

  it("a right-click elsewhere closes it; one on another row moves it there (item 5)", async () => {
    await mountOpen();
    await openMenu("step-2");
    document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector(".stack-branch-menu")).toBeNull();

    await openMenu("step-2");
    await rightClick(row("feature"));
    await flush();
    expect(document.querySelector(".stack-branch-menu")).not.toBeNull();
    expect(menuItems()).toEqual(["stacks.menu.stackOn"]);
  });
});
