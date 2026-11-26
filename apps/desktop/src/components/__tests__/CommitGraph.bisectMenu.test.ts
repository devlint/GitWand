// @vitest-environment jsdom
/**
 * CommitGraph.vue — guided bisect entries in the commit context menu.
 * Mounted like CommitGraph.multiSelect.test.ts; the real useCommitSelection runs.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import CommitGraph from "../CommitGraph.vue";
import type { GitLogEntry } from "../../utils/backend";
import { useCommitSelection } from "../../composables/useCommitSelection";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));
vi.mock("../../utils/platform", async (orig) => {
  const actual = await orig<typeof import("../../utils/platform")>();
  return { ...actual, isToggleModifier: (e: { ctrlKey: boolean }) => e.ctrlKey };
});

const full = (s: string) => s.padEnd(40, "0");
const names = ["aaa1111", "bbb2222", "ccc3333", "ddd4444"];
const commits: GitLogEntry[] = names.map((hash, i) => ({
  hash,
  hashFull: full(hash),
  author: "Dev",
  email: "dev@example.com",
  date: "2026-08-01T00:00:00Z",
  message: `commit ${hash}`,
  body: "",
  parents: i < names.length - 1 ? [full(names[i + 1])] : [],
  refs: i === 0 ? "HEAD -> main" : "",
}));

let app: App | null = null;
let container: HTMLElement | null = null;
let n = 0;
let cwd = "";

function mount(over: Record<string, unknown> = {}) {
  cwd = `/repo/bisect-${n++}`;
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
        onBisectBetween: on("bisect-between"),
        onBisectFromHere: on("bisect-from-here"),
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
});

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".cg-row"));
async function rightClick(i: number) {
  await nextTick();
  rows()[i].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await nextTick();
}
const item = (key: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".commit-ctx-menu-item")).find((e) =>
    e.textContent?.includes(key),
  );

describe("CommitGraph — bisect entries", () => {
  it("offers Bisect between on two selected commits: older good, newer bad", async () => {
    const { emitted } = mount();
    await nextTick();
    rows()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await rightClick(2);
    const between = item("bisect.menuBetween");
    expect(between).toBeDefined();
    between!.click();
    expect(emitted["bisect-between"]).toEqual([[full("ccc3333"), full("aaa1111")]]);
  });

  it("offers Bisect from here on a single commit that is not HEAD", async () => {
    const { emitted } = mount();
    await rightClick(2);
    item("bisect.menuFromHere")!.click();
    expect((emitted["bisect-from-here"]?.[0]?.[0] as GitLogEntry).hashFull).toBe(full("ccc3333"));
  });

  it("hides Bisect from here on HEAD", async () => {
    mount();
    await rightClick(0);
    expect(item("bisect.menuFromHere")).toBeUndefined();
  });

  it("hides both while an operation is in progress", async () => {
    mount({ operationInProgress: true });
    await nextTick();
    rows()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await rightClick(2);
    expect(item("bisect.menuBetween")).toBeUndefined();
    expect(item("bisect.menuFromHere")).toBeUndefined();
  });
});
