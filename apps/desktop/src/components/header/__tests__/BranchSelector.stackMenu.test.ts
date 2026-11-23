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

async function mountOpen() {
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
