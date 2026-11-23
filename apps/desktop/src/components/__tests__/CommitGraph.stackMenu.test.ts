// @vitest-environment jsdom
/**
 * CommitGraph.vue — stack items in the Git Tree branch context menu (QA bug 1).
 * "Stack on…" for a local non-trunk branch, "Unstack" for a stack layer,
 * "Restack…" when the chain has an actionable layer. Each item emits to the
 * parent (App.vue wires them to useStackActions), with the branch name.
 * Mounted like CommitGraph.branchSlash.test.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import CommitGraph from "../CommitGraph.vue";
import type { GitBranch, GitLogEntry, StackLayerStatus } from "../../utils/backend";
import { __setStacksForTest, type Stacks } from "../../composables/useStacks";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

const entry = (hash: string, refs: string): GitLogEntry => ({
  hash,
  hashFull: hash.padEnd(40, "0"),
  author: "Dev",
  email: "dev@example.com",
  date: "2026-08-01T00:00:00Z",
  message: refs,
  body: "",
  parents: [],
  refs,
});

const branch = (name: string, isRemote = false): GitBranch => ({
  name,
  isCurrent: name === "main",
  isRemote,
  upstream: null,
  ahead: 0,
  behind: 0,
  mainCommitCount: 1,
  lastCommit: "abc",
  lastCommitDate: "2026-08-01T00:00:00Z",
});

const commits = [
  entry("aaa1111", "HEAD -> main"),
  entry("bbb2222", "step-2"),
  entry("ccc3333", "feature"),
  entry("ddd4444", "origin/feature"),
];
const branches = [branch("main"), branch("step-2"), branch("feature"), branch("origin/feature", true)];

const layer = { branch: "step-2" } as StackLayerStatus;

let app: App | null = null;
let container: HTMLElement | null = null;

function mount(over: Record<string, unknown> = {}) {
  __setStacksForTest({
    report: ref({ trunk: "main" }),
    trunk: () => "main",
    layerOf: (b: string) => (b === "step-2" ? layer : null),
    actionableFor: (b: string) => (b === "step-2" ? layer : null),
  } as unknown as Stacks);
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
        branches,
        onStackOn: on("stack-on"),
        onUnstack: on("unstack"),
        onRestack: on("restack"),
        ...over,
      }),
  });
  app.mount(container);
  return { emitted };
}

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  __setStacksForTest(null);
});

async function openMenuOn(name: string) {
  await nextTick();
  const badge = Array.from(document.querySelectorAll<HTMLElement>(".cg-ref")).find(
    (el) => el.getAttribute("title") === name,
  );
  if (!badge) throw new Error(`ref badge "${name}" not found`);
  badge.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await nextTick();
}

const itemTexts = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".commit-ctx-menu-item")).map((el) => el.textContent?.trim() ?? "");
const item = (key: string) => {
  const el = Array.from(document.querySelectorAll<HTMLElement>(".commit-ctx-menu-item")).find((e) =>
    e.textContent?.includes(key),
  );
  if (!el) throw new Error(`menu item "${key}" not found`);
  return el;
};

describe("CommitGraph — stack items in the branch context menu", () => {
  it("offers all three items for a stacked, actionable local branch and emits each with the name", async () => {
    const { emitted } = mount();
    for (const [key, event] of [
      ["stacks.menu.stackOn", "stack-on"],
      ["stacks.menu.unstack", "unstack"],
      ["stacks.menu.restack", "restack"],
    ] as const) {
      await openMenuOn("step-2");
      item(key).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await nextTick();
      expect(emitted[event]).toEqual([["step-2"]]);
      expect(document.querySelector(".commit-ctx-menu")).toBeNull();
    }
  });

  it("offers only Stack on… for an unstacked local branch", async () => {
    mount();
    await openMenuOn("feature");
    const texts = itemTexts();
    expect(texts.some((x) => x.includes("stacks.menu.stackOn"))).toBe(true);
    expect(texts.some((x) => x.includes("stacks.menu.unstack"))).toBe(false);
    expect(texts.some((x) => x.includes("stacks.menu.restack"))).toBe(false);
  });

  it("offers no stack item for the trunk or a remote branch", async () => {
    mount();
    await openMenuOn("main");
    expect(itemTexts().some((x) => x.includes("stacks.menu."))).toBe(false);
    await openMenuOn("origin/feature");
    expect(itemTexts().some((x) => x.includes("stacks.menu."))).toBe(false);
  });
});

describe("CommitGraph — stack items on the checked-out branch (QA2 item 4)", () => {
  it("offers the items on the current (HEAD) branch when it is not the trunk", async () => {
    const { emitted } = mount({
      currentBranch: "step-2",
      commits: [entry("aaa1111", "main"), entry("bbb2222", "HEAD -> step-2")],
      branches: [branch("main"), { ...branch("step-2"), isCurrent: true }],
    });
    await openMenuOn("step-2");
    const texts = itemTexts();
    expect(texts.filter((x) => x.includes("stacks.menu.")).length).toBe(3);
    item("stacks.menu.unstack").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(emitted["unstack"]).toEqual([["step-2"]]);
  });
});
