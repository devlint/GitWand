// @vitest-environment jsdom
/**
 * CommitDiffViewer.vue — selecting lines to file an issue about (#301):
 * click a line number, Shift+click to extend within the hunk; the selection
 * is published to the issue form's `activeSelection` and cleared when it no
 * longer applies.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { createApp, h, nextTick, ref, type App, type Ref } from "vue";
import CommitDiffViewer from "../CommitDiffViewer.vue";
import { CREATE_ISSUE_KEY, createSelectionRegistry } from "../../composables/useCreateIssue";
import type { DiffLine, GitDiff, GitLogEntry } from "../../utils/backend";
import type { DiffSelection } from "../../utils/issuePrefill";

const wordDiffCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../utils/wordDiff", async (orig) => {
  const real = (await orig()) as typeof import("../../utils/wordDiff");
  return {
    ...real,
    wordDiff: (a: string, b: string) => {
      wordDiffCalls.n++;
      return real.wordDiff(a, b);
    },
  };
});

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref("en") }),
}));

beforeAll(() => {
  (globalThis as any).IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const SHA = "c0ffee1".padEnd(40, "1");
const PARENT = "beef000".padEnd(40, "0");
const ENTRY: GitLogEntry = {
  hash: "c0ffee1", hashFull: SHA, author: "Dev", email: "d@x", date: "", message: "m", body: "",
  parents: [PARENT], refs: "",
};

const DIFFS: GitDiff[] = [
  {
    path: "src/a.ts",
    hunks: [
      {
        header: "@@ -1,4 +1,4 @@",
        oldStart: 1, oldCount: 4, newStart: 1, newCount: 4,
        lines: [
          { type: "context", content: "a", oldLineNo: 1, newLineNo: 1 },
          { type: "delete", content: "b", oldLineNo: 2 },
          { type: "add", content: "B", newLineNo: 2 },
          { type: "context", content: "c", oldLineNo: 3, newLineNo: 3 },
          { type: "context", content: "d", oldLineNo: 4, newLineNo: 4 },
        ],
      },
      {
        header: "@@ -20,1 +20,1 @@",
        oldStart: 20, oldCount: 1, newStart: 20, newCount: 1,
        lines: [{ type: "context", content: "z", oldLineNo: 20, newLineNo: 20 }],
      },
    ],
  } as unknown as GitDiff,
];

let app: App | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function mount(opts: { available?: boolean; withProvider?: boolean; diffMode?: "inline" | "side-by-side"; commitInfo?: GitLogEntry | null } = {}) {
  const activeSelection = ref<DiffSelection | null>(null) as Ref<DiffSelection | null>;
  const openFromSelection = vi.fn(async (_sel: DiffSelection) => {});
  const fake = {
    available: ref(opts.available ?? true),
    activeSelection,
    openFromSelection,
    publishSelection: createSelectionRegistry(activeSelection),
  };
  const commitHash = ref<string | null>(SHA);
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    setup() {
      return () =>
        h(CommitDiffViewer as any, {
          diffs: DIFFS,
          commitHash: commitHash.value,
          commitInfo: opts.commitInfo === undefined ? ENTRY : opts.commitInfo,
          diffMode: opts.diffMode ?? "inline",
        });
    },
  });
  if (opts.withProvider !== false) app.provide(CREATE_ISSUE_KEY, fake as any);
  app.mount(container);
  return { fake, commitHash };
}

/** The line-number cells of hunk `h`, row `r` (inline: old then new). */
function numberCell(h: number, r: number, col = 1): HTMLElement {
  const hunk = document.querySelectorAll<HTMLElement>(".cdv-hunk")[h];
  const row = hunk.querySelectorAll<HTMLElement>("tr.cdv-line")[r];
  return row.querySelectorAll<HTMLElement>(".cdv-line-no")[col];
}

function click(el: HTMLElement, shift = false) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift }));
}

const contents = (sel: DiffSelection | null) => sel?.lines.map((l) => l.content);

describe("CommitDiffViewer — line selection for an issue", () => {
  it("a click selects one row and publishes it with its commit", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    const rows = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll("tr.cdv-line");
    expect(rows[1].classList.contains("cdv-line--selected")).toBe(true);
    expect(rows[0].classList.contains("cdv-line--selected")).toBe(false);
    expect(contents(fake.activeSelection.value)).toEqual(["b"]);
    expect(fake.activeSelection.value?.path).toBe("src/a.ts");
    expect(fake.activeSelection.value?.source).toEqual({ kind: "commit", hash: "c0ffee1", hashFull: SHA, parent: PARENT });
  });

  it("Shift+click extends within the hunk, either direction", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 3));
    click(numberCell(0, 1, 0), true);
    await nextTick();
    expect(contents(fake.activeSelection.value)).toEqual(["b", "B", "c"]);
  });

  it("Shift+click in another hunk starts a new selection there", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 1));
    click(numberCell(1, 0), true);
    await nextTick();
    expect(contents(fake.activeSelection.value)).toEqual(["z"]);
  });

  it("side by side: the left numbers select old-side lines only", async () => {
    const { fake } = mount({ diffMode: "side-by-side" });
    await nextTick();
    const hunk = document.querySelectorAll<HTMLElement>(".cdv-hunk")[0];
    const rows = hunk.querySelectorAll<HTMLElement>("tr.cdv-line");
    // Pairs: (a,a) (b,B) (c,c) (d,d) — left number cell is the first .cdv-line-no.
    click(rows[0].querySelectorAll<HTMLElement>(".cdv-line-no")[0]);
    click(rows[1].querySelectorAll<HTMLElement>(".cdv-line-no")[0], true);
    await nextTick();
    expect(contents(fake.activeSelection.value)).toEqual(["a", "b"]);
    // Picked in the old column: the link is to the old version.
    expect(fake.activeSelection.value?.side).toBe("old");
  });

  it("Shift+press on a line number does not start a text selection", async () => {
    mount();
    await nextTick();
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    numberCell(0, 1).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Escape, a click elsewhere, another commit and unmounting clear it", async () => {
    const { fake, commitHash } = mount();
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(fake.activeSelection.value).toBeNull();
    expect(document.querySelector(".cdv-line--selected")).toBeNull();

    click(numberCell(0, 1));
    await nextTick();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();
    expect(fake.activeSelection.value).toBeNull();

    click(numberCell(0, 1));
    await nextTick();
    commitHash.value = PARENT;
    await nextTick();
    expect(fake.activeSelection.value).toBeNull();

    click(numberCell(0, 1));
    await nextTick();
    expect(fake.activeSelection.value).not.toBeNull();
    app?.unmount();
    app = null;
    expect(fake.activeSelection.value).toBeNull();
  });

  it("the button files the selection; none without a GitHub repository", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    const btn = document.querySelector<HTMLElement>(".cdv-issue-btn");
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    click(btn!);
    expect(fake.openFromSelection).toHaveBeenCalledWith(expect.objectContaining({ path: "src/a.ts" }));
    expect(contents(fake.openFromSelection.mock.calls[0][0])).toEqual(["b"]);
  });

  it("selects nothing when issues cannot be created", async () => {
    mount({ available: false });
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    expect(document.querySelector(".cdv-line--selected")).toBeNull();
    expect(document.querySelector(".cdv-issue-btn")).toBeNull();
    app?.unmount();
    app = null;
    mount({ withProvider: false });
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    expect(document.querySelector(".cdv-line--selected")).toBeNull();
  });

  it("pressing the diff's own scroll area (its scrollbar) keeps the selection", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    document.querySelector(".cdv-content")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();
    expect(fake.activeSelection.value).not.toBeNull();
  });

  it("selects nothing when the commit's details are not loaded", async () => {
    mount({ commitInfo: null });
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    expect(document.querySelector(".cdv-issue-btn")).toBeNull();
    expect(document.querySelector(".cdv-line--selected")).toBeNull();
  });

  it("selecting does not redo the word diffs", async () => {
    mount({ diffMode: "side-by-side" });
    await nextTick();
    const before = wordDiffCalls.n;
    const rows = document.querySelectorAll<HTMLElement>(".cdv-hunk")[0].querySelectorAll<HTMLElement>("tr.cdv-line");
    click(rows[0].querySelectorAll<HTMLElement>(".cdv-line-no")[0]);
    await nextTick();
    click(rows[1].querySelectorAll<HTMLElement>(".cdv-line-no")[0], true);
    await nextTick();
    expect(wordDiffCalls.n).toBe(before);
  });

  it("publishes once issue creation becomes available", async () => {
    const { fake } = mount({ available: false });
    await nextTick();
    // Not selectable while unavailable; the published value follows availability.
    fake.available.value = true;
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    expect(fake.activeSelection.value).not.toBeNull();
    fake.available.value = false;
    await nextTick();
    expect(fake.activeSelection.value).toBeNull();
  });

  it("carries a renamed file's old path", async () => {
    const renamed = [{ ...DIFFS[0], oldPath: "src/old.ts" }] as GitDiff[];
    container = document.createElement("div");
    document.body.appendChild(container);
    const activeSelection = ref<DiffSelection | null>(null);
    app = createApp({ setup: () => () => h(CommitDiffViewer as any, { diffs: renamed, commitHash: SHA, commitInfo: ENTRY, diffMode: "inline" }) });
    app.provide(CREATE_ISSUE_KEY, { available: ref(true), activeSelection, openFromSelection: vi.fn(), publishSelection: createSelectionRegistry(activeSelection) } as any);
    app.mount(container);
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    expect(activeSelection.value?.oldPath).toBe("src/old.ts");
  });

  it("lets the selection go once its issue form has opened", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    fake.activeSelection.value?.onOpened?.();
    await nextTick();
    expect(fake.activeSelection.value).toBeNull();
    expect(document.querySelector(".cdv-line--selected")).toBeNull();
  });

  it("Escape meant for something else keeps the selection", async () => {
    const { fake } = mount();
    await nextTick();
    click(numberCell(0, 1));
    await nextTick();
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(fake.activeSelection.value).not.toBeNull();
  });

  it("a truncated file's last hunk keeps its word diffs between clicks", async () => {
    const lines: DiffLine[] = [];
    for (let i = 1; i <= 300; i++) {
      lines.push({ type: "delete", content: `o${i}`, oldLineNo: i });
      lines.push({ type: "add", content: `n${i}`, newLineNo: i });
    }
    const big = [{ path: "big.ts", hunks: [{ header: "@@ -1,300 +1,300 @@", oldStart: 1, oldCount: 300, newStart: 1, newCount: 300, lines }] }] as unknown as GitDiff[];
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({ setup: () => () => h(CommitDiffViewer as any, { diffs: big, commitHash: SHA, commitInfo: ENTRY, diffMode: "side-by-side" }) });
    const sink = ref<DiffSelection | null>(null);
    app.provide(CREATE_ISSUE_KEY, { available: ref(true), activeSelection: sink, openFromSelection: vi.fn(), publishSelection: createSelectionRegistry(sink) } as any);
    app.mount(container);
    await nextTick();
    const before = wordDiffCalls.n;
    click(document.querySelectorAll<HTMLElement>("tr.cdv-line")[0].querySelectorAll<HTMLElement>(".cdv-line-no")[0]);
    await nextTick();
    click(document.querySelectorAll<HTMLElement>("tr.cdv-line")[2].querySelectorAll<HTMLElement>(".cdv-line-no")[0], true);
    await nextTick();
    expect(wordDiffCalls.n).toBe(before);
  });
});
