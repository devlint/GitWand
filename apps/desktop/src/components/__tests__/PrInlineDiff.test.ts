// @vitest-environment jsdom
/**
 * PrInlineDiff.vue — flat row model + virtualization (Task A2, v3.6.0).
 *
 * Mounted with the native `createApp` (no @vue/test-utils dep), mirroring
 * LaunchpadView.test / MergeEditor.test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import PrInlineDiff from "../PrInlineDiff.vue";
import type { GitDiff, DiffHunk, DiffLine } from "../../utils/backend";
import type { LineAnnotation } from "../../composables/prAnnotations";

function line(type: DiffLine["type"], content: string, oldLineNo?: number, newLineNo?: number): DiffLine {
  return { type, content, oldLineNo, newLineNo };
}

/** A single hunk with `n` context lines — used to push the row count past
 *  the virtualization threshold with one big hunk (the scenario the spec's
 *  success metric targets: "5 000-line file's diff DOM is bounded"). */
function bigHunk(n: number): DiffHunk {
  const lines: DiffLine[] = [];
  for (let i = 1; i <= n; i++) lines.push(line("context", `line ${i}`, i, i));
  return { header: `@@ -1,${n} +1,${n} @@`, oldStart: 1, oldCount: n, newStart: 1, newCount: n, lines };
}

function smallDiff(): GitDiff {
  return {
    path: "src/foo.ts",
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          line("context", "unchanged", 1, 1),
          line("delete", "old value", 2, undefined),
          line("add", "new value", undefined, 2),
        ],
      },
    ],
  };
}

interface MountResult { app: App; container: HTMLDivElement; vm: any }

function mountDiff(props: Record<string, unknown>): MountResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(PrInlineDiff as any, props);
  const vm = app.mount(container);
  return { app, container, vm };
}

function unmount({ app, container }: MountResult) {
  app.unmount();
  if (container.parentNode) container.parentNode.removeChild(container);
}

describe("PrInlineDiff — flat row model", () => {
  let mounted: MountResult | null = null;

  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  it("renders the full DOM (non-virtual) for a small diff, boxed per hunk", async () => {
    mounted = mountDiff({ diff: smallDiff(), filePath: "src/foo.ts", comments: [] });
    await nextTick();
    expect(mounted.container.querySelector(".pid-rows--virtual")).toBeNull();
    const rowEls = mounted.container.querySelectorAll("[data-row-index]");
    // hunk-header + 3 lines = 4 rows for this fixture.
    expect(rowEls.length).toBe(4);
    expect(rowEls[0].classList.contains("pid-rowbox--start")).toBe(true);
    expect(rowEls[rowEls.length - 1].classList.contains("pid-rowbox--end")).toBe(true);
  });

  it("renders CI annotation gutter icons", async () => {
    const annotations: LineAnnotation[] = [
      { source: "ci", checkName: "lint", severity: "warning", line: 2, endLine: 2, side: "RIGHT", title: "warn", message: "", path: "src/foo.ts" },
    ];
    mounted = mountDiff({ diff: smallDiff(), filePath: "src/foo.ts", comments: [], annotations });
    await nextTick();
    expect(mounted.container.querySelector(".pid-ann-icon--warning")).not.toBeNull();
  });

  it("switches to the virtualized path once row count crosses the threshold, bounding the DOM", async () => {
    const diff: GitDiff = { path: "src/big.ts", hunks: [bigHunk(5000)] };
    mounted = mountDiff({ diff, filePath: "src/big.ts", comments: [] });
    await nextTick();
    await nextTick();
    expect(mounted.container.querySelector(".pid-rows--virtual")).not.toBeNull();
    // jsdom has no real layout (zero-size viewport), so the virtualizer may
    // report an empty visible window — the point of this assertion is that
    // the DOM never grows anywhere near the full 5001-row count, not a
    // specific viewport-dependent number.
    const rowEls = mounted.container.querySelectorAll("[data-row-index]");
    expect(rowEls.length).toBeLessThan(200);
  });

  it("exposes scrollToHunk / scrollToLine / rows for keyboard nav (B1)", async () => {
    mounted = mountDiff({ diff: smallDiff(), filePath: "src/foo.ts", comments: [] });
    await nextTick();
    // `defineExpose`d refs are unwrapped on the public mount-instance proxy
    // (same auto-unwrap as template access) — so `currentRowIdx` reads as a
    // plain number here, not `{ value }`.
    const exposed = mounted.vm as unknown as {
      scrollToHunk: (i: number) => void;
      scrollToLine: (i: number) => void;
      rows: { kind: string }[];
      currentRowIdx: number;
    };
    expect(typeof exposed.scrollToHunk).toBe("function");
    expect(typeof exposed.scrollToLine).toBe("function");
    expect(exposed.rows.map((r) => r.kind)).toEqual(["hunk-header", "line", "line", "line"]);
    exposed.scrollToHunk(0);
    expect(exposed.currentRowIdx).toBe(0);
    exposed.scrollToLine(2);
    expect(exposed.currentRowIdx).toBe(2);
  });
});

// ─── Shift+click ranges: multi-line comments and issues (#301) ───────────────
import { ref as vueRef, h } from "vue";
import { vi } from "vitest";
import { CREATE_ISSUE_KEY, createSelectionRegistry } from "../../composables/useCreateIssue";
import type { DiffSelection } from "../../utils/issuePrefill";

function rangeDiff(): GitDiff {
  const ctx = (n: number) => line("context", `c${n}`, n, n);
  return {
    path: "src/r.ts",
    hunks: [
      { header: "@@ -1,8 +1,8 @@", oldStart: 1, oldCount: 8, newStart: 1, newCount: 8, lines: [1, 2, 3, 4, 5, 6, 7, 8].map(ctx) },
      { header: "@@ -40,1 +40,1 @@", oldStart: 40, oldCount: 1, newStart: 40, newCount: 1, lines: [ctx(40)] },
    ],
  };
}

function mountRange(props: Record<string, unknown> = {}, available = true) {
  const activeSelection = vueRef<DiffSelection | null>(null);
  // Opens unless told otherwise; tells the view, like the real one.
  let opens = true;
  const openFromSelection = vi.fn(async (sel: DiffSelection) => {
    if (opens) sel.onOpened?.();
    return opens;
  });
  const fake = {
    available: vueRef(available),
    activeSelection,
    openFromSelection,
    publishSelection: createSelectionRegistry(activeSelection),
    refuse: () => { opens = false; },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(PrInlineDiff as any, {
    diff: rangeDiff(), filePath: "src/r.ts", comments: [], prNumber: 12,
    prUrl: "https://github.com/o/r/pull/12", headSha: "h".repeat(40), forgeName: "github", ...props,
  });
  app.provide(CREATE_ISSUE_KEY, fake as any);
  const vm = app.mount(container);
  return { mounted: { app, container, vm } as MountResult, fake };
}

/** The new-side line-number cell of the line row numbered `n`. */
function newNo(container: HTMLElement, n: number): HTMLElement {
  for (const row of container.querySelectorAll<HTMLElement>(".pid-row")) {
    const cells = row.querySelectorAll<HTMLElement>(".pid-lno");
    if (cells[1]?.querySelector(".pid-lno-num")?.textContent?.trim() === String(n)) return cells[1];
  }
  throw new Error(`no line ${n}`);
}

function clickNo(el: HTMLElement, shift = false) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift }));
}

describe("PrInlineDiff — Shift+click ranges", () => {
  let mounted: MountResult | null = null;
  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  async function typeInCompose(c: HTMLElement, text: string) {
    const ta = c.querySelector<HTMLTextAreaElement>(".pid-compose textarea")!;
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    await nextTick();
  }

  it("extends the compose box to a range, keeps the text, comments on the range", async () => {
    const created = vi.fn();
    const r = mountRange({ onCreateComment: created });
    mounted = r.mounted;
    const c2 = r.mounted.container;
    await nextTick();
    clickNo(newNo(c2, 3));
    await nextTick();
    await typeInCompose(c2, "x");
    clickNo(newNo(c2, 6), true);
    await nextTick();
    const ta = c2.querySelector<HTMLTextAreaElement>(".pid-compose textarea")!;
    expect(ta.value).toBe("x");
    // The compose box sits under line 6.
    const composeRow = c2.querySelector<HTMLElement>(".pid-compose-row")!;
    const before = composeRow.previousElementSibling as HTMLElement;
    expect(before.querySelectorAll(".pid-lno-num")[1].textContent?.trim()).toBe("6");
    expect(c2.querySelectorAll(".pid-row--selected")).toHaveLength(4);
    c2.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ line: 6, side: "RIGHT", start_line: 3, start_side: "RIGHT", body: "x" }));
  });

  it("Shift+click above the compose line keeps the box on the later row", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 6));
    await nextTick();
    clickNo(newNo(c, 3), true);
    await nextTick();
    const before = c.querySelector<HTMLElement>(".pid-compose-row")!.previousElementSibling as HTMLElement;
    expect(before.querySelectorAll(".pid-lno-num")[1].textContent?.trim()).toBe("6");
    expect(r.fake.activeSelection.value?.lines.map((l) => l.content)).toEqual(["c3", "c4", "c5", "c6"]);
  });

  it("Shift+click in another hunk opens a plain compose box there", async () => {
    const created = vi.fn();
    const r = mountRange({ onCreateComment: created });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    await nextTick();
    clickNo(newNo(c, 40), true);
    await nextTick();
    expect(c.querySelectorAll(".pid-row--selected")).toHaveLength(0);
    await typeInCompose(c, "y");
    c.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    const params = created.mock.calls[0][0];
    expect(params.line).toBe(40);
    expect(params.start_line).toBeUndefined();
  });

  it("Create issue files the range with the typed text; the draft and range stay for the comment", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    await nextTick();
    await typeInCompose(c, "x");
    clickNo(newNo(c, 6), true);
    await nextTick();
    c.querySelector<HTMLButtonElement>(".pid-issue-btn")!.click();
    await nextTick();
    const sel = r.fake.openFromSelection.mock.calls[0][0];
    expect(sel.lines.map((l) => l.content)).toEqual(["c3", "c4", "c5", "c6"]);
    expect(sel.intro).toBe("x");
    expect(sel.source).toEqual({ kind: "pr", number: 12, url: "https://github.com/o/r/pull/12", headSha: "h".repeat(40) });
    // Cancelling the issue must not have cost the comment draft, nor its range.
    expect(c.querySelector<HTMLTextAreaElement>(".pid-compose textarea")?.value).toBe("x");
    expect(c.querySelectorAll(".pid-row--selected")).toHaveLength(4);
    // Filed: ⌘⇧I is about something else now.
    expect(r.fake.activeSelection.value).toBeNull();
  });

  it("no Create issue without a PR URL or a GitHub repository", async () => {
    const a = mountRange({ prUrl: undefined });
    mounted = a.mounted;
    await nextTick();
    clickNo(newNo(a.mounted.container, 3));
    await nextTick();
    expect(a.mounted.container.querySelector(".pid-issue-btn")).toBeNull();
    unmount(a.mounted);
    const b = mountRange({}, false);
    mounted = b.mounted;
    await nextTick();
    clickNo(newNo(b.mounted.container, 3));
    await nextTick();
    expect(b.mounted.container.querySelector(".pid-issue-btn")).toBeNull();
  });

  it("closing the box clears the published selection", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 4), true);
    await nextTick();
    expect(r.fake.activeSelection.value).not.toBeNull();
    c.querySelector<HTMLButtonElement>(".pid-cancel-btn")!.click();
    await nextTick();
    expect(r.fake.activeSelection.value).toBeNull();
  });

  it("changing file closes the box and clears the selection", async () => {
    const activeSelection = vueRef<DiffSelection | null>(null);
    const fake = { available: vueRef(true), activeSelection, openFromSelection: vi.fn(), publishSelection: createSelectionRegistry(activeSelection) };
    const filePath = vueRef("src/r.ts");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({
      render: () => h(PrInlineDiff as any, {
        diff: rangeDiff(), filePath: filePath.value, comments: [], prNumber: 12,
        prUrl: "https://github.com/o/r/pull/12", headSha: "h".repeat(40), forgeName: "github",
      }),
    });
    app.provide(CREATE_ISSUE_KEY, fake as any);
    app.mount(container);
    mounted = { app, container, vm: null };
    await nextTick();
    clickNo(newNo(container, 3));
    clickNo(newNo(container, 5), true);
    await nextTick();
    expect(activeSelection.value).not.toBeNull();
    filePath.value = "src/other.ts";
    await nextTick();
    await nextTick();
    expect(container.querySelector(".pid-compose")).toBeNull();
    expect(activeSelection.value).toBeNull();
  });

  /** One modified line: `-old` (old 2) then `+new` (new 2), with context around. */
  function modifiedDiff(): GitDiff {
    return {
      path: "src/m.ts",
      hunks: [{
        header: "@@ -1,3 +1,3 @@", oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          line("context", "a", 1, 1),
          line("delete", "old", 2, undefined),
          line("add", "new", undefined, 2),
          line("context", "z", 3, 3),
        ],
      }],
    };
  }
  function cells(container: HTMLElement, rowIdx: number): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".pid-row")[rowIdx].querySelectorAll<HTMLElement>(".pid-lno")];
  }

  it("a deleted-then-added line with the same number is still a range comment", async () => {
    const created = vi.fn();
    const r = mountRange({ diff: modifiedDiff(), filePath: "src/m.ts", onCreateComment: created });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(cells(c, 1)[0]); // -old, old number 2
    await nextTick();
    clickNo(cells(c, 2)[1], true); // +new, new number 2
    await nextTick();
    await typeInCompose(c, "x");
    c.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ line: 2, side: "RIGHT", start_line: 2, start_side: "LEFT" }));
  });

  it("a range ending on a deleted line starts on the old side", async () => {
    const created = vi.fn();
    const r = mountRange({ diff: modifiedDiff(), filePath: "src/m.ts", onCreateComment: created });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(cells(c, 0)[1]); // context a (1/1)
    await nextTick();
    clickNo(cells(c, 1)[0], true); // -old (old 2)
    await nextTick();
    await typeInCompose(c, "x");
    c.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ line: 2, side: "LEFT", start_line: 1, start_side: "LEFT" }));
  });

  it("other forges get no range (their comments are single-line)", async () => {
    const created = vi.fn();
    const r = mountRange({ forgeName: "gitea", onCreateComment: created });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    await nextTick();
    clickNo(newNo(c, 6), true);
    await nextTick();
    expect(c.querySelectorAll(".pid-row--selected")).toHaveLength(0);
    await typeInCompose(c, "x");
    c.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    expect(created.mock.calls[0][0].start_line).toBeUndefined();
  });

  it("a lone comment box is not a selection; a range is, with the text typed", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    await nextTick();
    expect(r.fake.activeSelection.value).toBeNull();
    clickNo(newNo(c, 5), true);
    await nextTick();
    expect(r.fake.activeSelection.value).not.toBeNull();
    await typeInCompose(c, "typing");
    expect(r.fake.activeSelection.value?.intro).toBe("typing");
    // ⌘⇧I files it: the range is handed over, the draft stays.
    r.fake.activeSelection.value?.onOpened?.();
    await nextTick();
    expect(c.querySelector<HTMLTextAreaElement>(".pid-compose textarea")?.value).toBe("typing");
    expect(r.fake.activeSelection.value).toBeNull();
  });

  it("keeps the box and its text when the issue form does not open", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    r.fake.refuse();
    await nextTick();
    clickNo(newNo(c, 3));
    await nextTick();
    await typeInCompose(c, "keep me");
    c.querySelector<HTMLButtonElement>(".pid-issue-btn")!.click();
    await nextTick();
    await nextTick();
    expect(c.querySelector<HTMLTextAreaElement>(".pid-compose textarea")?.value).toBe("keep me");
  });

  it("an add-to-delete range starts on the first old-side row", async () => {
    const created = vi.fn();
    const diff: GitDiff = {
      path: "src/m.ts",
      hunks: [{
        header: "@@ -1,3 +1,3 @@", oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          line("delete", "a", 1, undefined),
          line("add", "b", undefined, 1),
          line("context", "ctx", 2, 2),
          line("delete", "c", 3, undefined),
        ],
      }],
    };
    const r = mountRange({ diff, filePath: "src/m.ts", onCreateComment: created });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(cells(c, 1)[1]); // +b
    await nextTick();
    clickNo(cells(c, 3)[0], true); // -c
    await nextTick();
    await typeInCompose(c, "x");
    c.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ line: 3, side: "LEFT", start_line: 2, start_side: "LEFT" }));
  });

  it("publishes a range once issue creation becomes available", async () => {
    const r = mountRange({}, false);
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 5), true);
    await nextTick();
    expect(r.fake.activeSelection.value).toBeNull();
    r.fake.available.value = true;
    await nextTick();
    expect(r.fake.activeSelection.value?.lines.map((l) => l.content)).toEqual(["c3", "c4", "c5"]);
  });

  it("carries a renamed file's old path", async () => {
    const r = mountRange({ diff: { ...rangeDiff(), oldPath: "src/old.ts" } });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 4), true);
    await nextTick();
    expect(r.fake.activeSelection.value?.oldPath).toBe("src/old.ts");
  });

  it("Shift+click gives the focus back to the text being typed", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    await nextTick();
    clickNo(newNo(c, 6), true);
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(c.querySelector(".pid-compose textarea"));
  });

  it("the box is drawn under its own row only, not under a same-numbered row elsewhere", async () => {
    const twin: GitDiff = {
      path: "src/t.ts",
      hunks: [
        { header: "@@ -1,1 +1,1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [line("context", "a", 1, 1)] },
        { header: "@@ -1,1 +1,1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [line("context", "b", 1, 1)] },
      ],
    };
    const r = mountRange({ diff: twin, filePath: "src/t.ts" });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(c.querySelectorAll<HTMLElement>(".pid-row")[1].querySelectorAll<HTMLElement>(".pid-lno")[1]);
    await nextTick();
    expect(c.querySelectorAll(".pid-compose-row")).toHaveLength(1);
  });

  function mountReactive(diff: { value: GitDiff }) {
    const activeSelection = vueRef<DiffSelection | null>(null);
    const fake = { available: vueRef(true), activeSelection, openFromSelection: vi.fn(), publishSelection: createSelectionRegistry(activeSelection) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({
      render: () => h(PrInlineDiff as any, {
        diff: diff.value, filePath: "src/r.ts", comments: [], prNumber: 12,
        prUrl: "https://github.com/o/r/pull/12", headSha: "h".repeat(40), forgeName: "github",
      }),
    });
    app.provide(CREATE_ISSUE_KEY, fake as any);
    app.mount(container);
    return { mounted: { app, container, vm: null } as MountResult, fake };
  }

  it("a reloaded diff keeps the box and range on the same lines", async () => {
    const diff = vueRef(rangeDiff());
    const r = mountReactive(diff);
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 5), true);
    await nextTick();
    await typeInCompose(c, "draft");
    // Same file, one more line on top: every row moves down by one.
    const shifted = rangeDiff();
    shifted.hunks[0] = {
      ...shifted.hunks[0],
      lines: [line("add", "new top", undefined, 1), ...shifted.hunks[0].lines.map((l) => ({ ...l, newLineNo: (l.newLineNo ?? 0) + 1 }))],
    };
    diff.value = shifted;
    await nextTick();
    await nextTick();
    expect(c.querySelector<HTMLTextAreaElement>(".pid-compose textarea")?.value).toBe("draft");
    expect(r.fake.activeSelection.value?.lines.map((l) => l.content)).toEqual(["c3", "c4", "c5"]);
  });

  it("a reloaded diff without those lines closes the box", async () => {
    const diff = vueRef(rangeDiff());
    const r = mountReactive(diff);
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 5), true);
    await nextTick();
    diff.value = { ...rangeDiff(), hunks: [rangeDiff().hunks[1]] };
    await nextTick();
    await nextTick();
    expect(c.querySelector(".pid-compose")).toBeNull();
    expect(r.fake.activeSelection.value).toBeNull();
  });

  it("Shift+press on a line number does not start a text selection", async () => {
    const r = mountRange();
    mounted = r.mounted;
    await nextTick();
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    newNo(r.mounted.container, 3).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("after filing an issue, the comment still covers the range", async () => {
    const created = vi.fn();
    const r = mountRange({ onCreateComment: created });
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 6), true);
    await nextTick();
    await typeInCompose(c, "x");
    c.querySelector<HTMLButtonElement>(".pid-issue-btn")!.click();
    await nextTick();
    c.querySelector<HTMLButtonElement>(".pid-submit-btn")!.click();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ line: 6, start_line: 3 }));
  });

  it("the comment box lets the new-issue shortcut through", async () => {
    const r = mountRange();
    mounted = r.mounted;
    await nextTick();
    clickNo(newNo(r.mounted.container, 3));
    await nextTick();
    expect(r.mounted.container.querySelector(".pid-compose textarea")?.hasAttribute("data-issue-shortcut")).toBe(true);
  });

  it("typing keeps the published range the same (it does not jump ahead of others)", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 5), true);
    await nextTick();
    const sel = r.fake.activeSelection.value;
    await typeInCompose(c, "more text");
    expect(r.fake.activeSelection.value).toBe(sel);
    expect(sel?.intro).toBe("more text");
  });

  it("a range filed as an issue is not offered again after the diff reloads", async () => {
    const diff = vueRef(rangeDiff());
    const r = mountReactive(diff);
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 5), true);
    await nextTick();
    r.fake.activeSelection.value?.onOpened?.();
    await nextTick();
    expect(r.fake.activeSelection.value).toBeNull();
    diff.value = rangeDiff();
    await nextTick();
    await nextTick();
    expect(c.querySelectorAll(".pid-row--selected")).toHaveLength(3);
    expect(r.fake.activeSelection.value).toBeNull();
  });

  it("Shift+press is left to the browser where no range can be made", async () => {
    const r = mountRange({ forgeName: "gitlab" });
    mounted = r.mounted;
    await nextTick();
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    newNo(r.mounted.container, 3).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("another PR closes the box even when the file has the same path", async () => {
    const prNumber = vueRef(12);
    const activeSelection = vueRef<DiffSelection | null>(null);
    const fake = { available: vueRef(true), activeSelection, openFromSelection: vi.fn(), publishSelection: createSelectionRegistry(activeSelection) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({
      render: () => h(PrInlineDiff as any, {
        diff: rangeDiff(), filePath: "src/r.ts", comments: [], prNumber: prNumber.value,
        prUrl: `https://github.com/o/r/pull/${prNumber.value}`, headSha: "h".repeat(40), forgeName: "github",
      }),
    });
    app.provide(CREATE_ISSUE_KEY, fake as any);
    app.mount(container);
    mounted = { app, container, vm: null };
    await nextTick();
    clickNo(newNo(container, 3));
    await nextTick();
    prNumber.value = 13;
    await nextTick();
    await nextTick();
    expect(container.querySelector(".pid-compose")).toBeNull();
  });

  it("a Shift+click that cannot extend keeps the draft (another hunk, another forge)", async () => {
    for (const forgeName of ["github", "gitlab"]) {
      const r = mountRange({ forgeName });
      mounted = r.mounted;
      const c = r.mounted.container;
      await nextTick();
      clickNo(newNo(c, 3));
      await nextTick();
      await typeInCompose(c, "keep");
      clickNo(newNo(c, forgeName === "github" ? 40 : 5), true);
      await nextTick();
      expect(c.querySelector<HTMLTextAreaElement>(".pid-compose textarea")?.value).toBe("keep");
      unmount(r.mounted);
      mounted = null;
    }
  });

  it("filing stops offering the filed range only, not a range picked since", async () => {
    const r = mountRange();
    mounted = r.mounted;
    const c = r.mounted.container;
    await nextTick();
    clickNo(newNo(c, 3));
    clickNo(newNo(c, 4), true);
    await nextTick();
    const filed = r.fake.activeSelection.value!;
    clickNo(newNo(c, 6), true);
    await nextTick();
    filed.onOpened?.();
    await nextTick();
    expect(r.fake.activeSelection.value?.lines.map((l) => l.content)).toEqual(["c3", "c4", "c5", "c6"]);
  });
});
