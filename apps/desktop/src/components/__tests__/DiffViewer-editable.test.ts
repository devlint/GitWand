// @vitest-environment jsdom
/**
 * DiffViewer.vue — editing a hunk in place (v3.11.0).
 *
 * Deliberately the narrowest thing that is still useful, and most of these
 * assertions are about where editing is NOT offered:
 *
 *  - `editable` defaults to false, so `SplitCommitModal` (the one place that
 *    imports DiffViewer statically), commit diffs and file history are
 *    untouched by this feature existing.
 *  - side-by-side has no single-column text substrate; two editors side by
 *    side is a different, much larger feature.
 *  - one hunk at a time, which is what bounds the invalidation problem: while
 *    a hunk is open the rest of the diff is frozen.
 *
 * The `colspan` assertion guards a trap this file already documents for the
 * commit-review finding rows: a `<td>` with `display: flex` stops being a
 * table-cell in the CSS box model, and the browser then silently ignores
 * `colspan` and squeezes the row into column one. The edit row reuses that
 * shape, so it has to reuse the discipline.
 *
 * The real `CodeEditor` is mounted. It is async-imported (it is the gateway to
 * ~400 KB of CodeMirror), which is also why the helpers below drain macrotasks
 * rather than a single `nextTick`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import type { GitDiff, DiffLine } from "../../utils/backend";
import { loadCodeMirror } from "../../utils/codemirrorLibs";
import { installCodeMirrorDomShims } from "../../test-utils/codemirrorDom";

// The edit box autofocuses, so CodeMirror measures the cursor. Local to this
// file; see the helper for why it must not live in `src/test-setup.ts`.
installCodeMirrorDomShims();



import DiffViewer from "../DiffViewer.vue";

const line = (type: DiffLine["type"], content: string, o?: number, n?: number): DiffLine => ({
  type, content, oldLineNo: o, newLineNo: n,
});

/** Two hunks, so "one at a time" is observable. */
function diff(): GitDiff {
  return {
    path: "src/app.ts",
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          line("context", "alpha", 1, 1),
          line("delete", "OLD", 2, undefined),
          line("add", "new-two", undefined, 2),
          line("context", "gamma", 3, 3),
        ],
      },
      {
        header: "@@ -10,2 +10,2 @@",
        oldStart: 10, oldCount: 2, newStart: 10, newCount: 2,
        lines: [
          line("delete", "OLD-TEN", 10, undefined),
          line("add", "new-ten", undefined, 10),
          line("context", "eleven", 11, 11),
        ],
      },
    ],
  } as unknown as GitDiff;
}

let app: App | null = null;
let container: HTMLElement;
const emitted: unknown[][] = [];

beforeEach(() => {
  localStorage.clear();
  emitted.length = 0;
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function mountViewer(props: Record<string, unknown> = {}) {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(DiffViewer, {
          diff: diff(),
          filePath: "src/app.ts",
          diffMode: "inline",
          editable: true,
          ...props,
          onEditHunk: (...args: unknown[]) => emitted.push(args),
        } as never);
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
}

const pencils = () => [...container.querySelectorAll<HTMLButtonElement>(".hunk-edit-btn")];
const editRow = () => container.querySelector<HTMLElement>(".diff-edit-row");

/** Drain microtasks and macrotasks: CodeEditor resolves a dynamic import. */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The live EditorView inside the edit row. */
async function liveView() {
  const libs = await loadCodeMirror();
  const el = container.querySelector<HTMLElement>(".diff-edit-row .cm-editor");
  return el ? libs.EditorView.findFromDOM(el) : null;
}

async function editorText(): Promise<string | null> {
  const v = await liveView();
  return v ? v.state.doc.toString() : null;
}

async function openHunk(n = 0) {
  pencils()[n].click();
  await settle();
}

const openFirstHunk = () => openHunk(0);

describe("DiffViewer — where editing is offered", () => {
  it("offers a pencil per hunk when the parent opts in", () => {
    mountViewer();
    expect(pencils()).toHaveLength(2);
  });

  it("offers nothing when editable is false", () => {
    // SplitCommitModal, commit diffs, file history: unchanged by this feature.
    mountViewer({ editable: false });
    expect(pencils()).toHaveLength(0);
  });

  it("offers nothing when editable is simply absent", () => {
    mountViewer({ editable: undefined });
    expect(pencils()).toHaveLength(0);
  });

  it("offers nothing in side-by-side mode", () => {
    mountViewer({ diffMode: "side-by-side" });
    expect(pencils()).toHaveLength(0);
  });

  it("offers nothing without a file path to write back to", () => {
    mountViewer({ filePath: null });
    expect(pencils()).toHaveLength(0);
  });
});

describe("DiffViewer — the edit row", () => {
  it("opens one editor, seeded with the hunk's post-image", async () => {
    mountViewer();
    expect(editRow()).toBeNull();

    await openFirstHunk();

    expect(editRow()).not.toBeNull();
    // Context plus adds, deletes dropped: what is on disk over that range.
    expect(await editorText()).toBe("alpha\nnew-two\ngamma");
  });

  it("spans the full diff width, and keeps the td a real table-cell", async () => {
    // A <td> with `display: flex` stops being a table-cell and the browser
    // silently ignores colspan, squeezing the row into column one.
    mountViewer({ selectable: true });
    await openFirstHunk();

    const cell = container.querySelector<HTMLElement>(".diff-edit-cell")!;
    expect(cell.getAttribute("colspan")).toBe("5");
    expect(getComputedStyle(cell).display, "must stay a table-cell").not.toBe("flex");
  });

  it("uses the narrower colspan when the diff is not selectable", async () => {
    mountViewer({ selectable: false });
    await openFirstHunk();
    expect(container.querySelector(".diff-edit-cell")!.getAttribute("colspan")).toBe("4");
  });

  it("edits ONE hunk at a time: the other pencil is disabled, not hidden", async () => {
    mountViewer();
    await openFirstHunk();

    expect(container.querySelectorAll(".diff-edit-row")).toHaveLength(1);
    // Disabled rather than removed, so the reason it is unavailable is visible.
    expect(pencils().every((p) => p.disabled)).toBe(true);
  });

  it("cancelling closes the editor and emits nothing", async () => {
    mountViewer();
    await openFirstHunk();

    const cancel = [...container.querySelectorAll<HTMLButtonElement>(".diff-edit-btn")]
      .find((b) => !b.className.includes("--primary"))!;
    cancel.click();
    await settle(5);

    expect(editRow()).toBeNull();
    expect(emitted).toHaveLength(0);
    expect(pencils().every((p) => p.disabled), "pencils re-enabled").toBe(false);
  });

  it("confirming hands the parent the path, the hunk index and the new text", async () => {
    // Deliberately NOT the spliced file: the splice needs the bytes currently
    // on disk, and that read belongs to the app shell.
    mountViewer();
    await openFirstHunk();

    const view = await liveView();
    view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: "alpha\nEDITED\ngamma" } });
    await settle(5);

    container.querySelector<HTMLButtonElement>(".diff-edit-btn--primary")!.click();
    await settle(5);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(["src/app.ts", 0, "alpha\nEDITED\ngamma"]);
    expect(editRow(), "the editor closes on confirm").toBeNull();
  });

  it("opens the hunk that was clicked, not always the first", async () => {
    mountViewer();
    await openHunk(1);

    expect(await editorText()).toBe("new-ten\neleven");

    container.querySelector<HTMLButtonElement>(".diff-edit-btn--primary")!.click();
    await settle(5);
    expect(emitted[0][1], "the second hunk's index").toBe(1);
  });
});
