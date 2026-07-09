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
