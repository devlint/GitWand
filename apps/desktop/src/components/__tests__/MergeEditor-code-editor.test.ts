// @vitest-environment jsdom
/**
 * MergeEditor.vue — the custom-edit box is a CodeMirror editor (v3.11.0).
 *
 * A separate file from `MergeEditor.test.ts` on purpose: that one exists solely
 * as the minimap `ResizeObserver` regression guard and installs a fake
 * observer, so mixing this in would obscure what it protects.
 *
 * The REAL `CodeEditor` is mounted, not a stub. The T0 spike established that
 * CodeMirror 6 mounts in this repo's jsdom with no shim, and a stub here would
 * only prove that MergeEditor passes props to something — not that a real
 * editor appears, holds the right text, and hands edits back. The one thing
 * jsdom cannot do is measure layout (`coordsAtPos` throws), and nothing below
 * needs coordinates.
 *
 * Two of these cover flows with no test at all before now:
 *
 *  - confirming an edit emits `resolveHunkCustom`. This is the path that
 *    writes a hand-edited resolution to a real file, and nothing covered it.
 *  - the AI suggestion arriving while the box is already open. That path sets
 *    `editContent` and only then `editingHunkIndex`, so it depends entirely on
 *    the inbound `watch(modelValue)` in CodeEditor. A "seed the doc on mount
 *    only" implementation breaks it silently, and the textarea it replaces
 *    could not have noticed because `v-model` on a textarea is two-way for
 *    free.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, reactive, nextTick, type App } from "vue";
import type { ConflictFile } from "../../composables/useGitWand";
import { useResolutionSelection } from "../../composables/useResolutionSelection";
import { loadCodeMirror } from "../../utils/codemirrorLibs";
import { installCodeMirrorDomShims } from "../../test-utils/codemirrorDom";

// The edit box autofocuses, which makes CodeMirror's selection layer measure
// the cursor, which needs `Range.getClientRects`. jsdom does not have it. This
// is local to this file on purpose; see the helper for why it must not go in
// `src/test-setup.ts`.
installCodeMirrorDomShims();



const aiSuggest = vi.fn(async () => ({ resolvedContent: "AI SUGGESTED CONTENT" }));
vi.mock("../../composables/useAIProvider", () => ({
  useAIProvider: () => ({
    suggestResolution: aiSuggest,
    isConfigured: () => true,
    provider: { value: "claude" },
    toLlmEndpoint: () => null,
  }),
}));

import MergeEditor from "../MergeEditor.vue";

class FakeResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PATH = "src/conflict.ts";
const CONTENT = [
  "header",
  "<<<<<<< ours",
  "ours-line",
  "||||||| base",
  "base-line",
  "=======",
  "theirs-line",
  ">>>>>>> theirs",
  "middle",
  "<<<<<<< ours",
  "ours-two",
  "||||||| base",
  "base-two",
  "=======",
  "theirs-two",
  ">>>>>>> theirs",
  "footer",
].join("\n");

function hunk(n: number) {
  return {
    baseLines: [`base-${n}`],
    oursLines: [`ours-${n}`],
    theirsLines: [`theirs-${n}`],
    startLine: n,
    type: "complex",
    confidence: {
      score: 60,
      label: "medium",
      dimensions: {
        typeClassification: 100, dataRisk: 100, scopeImpact: 0,
        fileFrequency: 0, baseAvailability: 0,
      },
      boosters: [],
      penalties: [],
    },
    explanation: "",
    trace: { selected: "complex", steps: [] },
  } as never;
}

/** Two complex hunks: the engine refuses both, so the manual edit path shows. */
function conflictFile(): ConflictFile {
  const hunks = [hunk(1), hunk(2)];
  return {
    path: PATH,
    content: CONTENT,
    result: {
      filePath: PATH,
      mergedContent: null,
      hunks,
      resolutions: hunks.map((h) => ({
        hunk: h,
        resolvedLines: null,
        autoResolved: false,
        resolutionReason: "complex",
      })),
      stats: { totalConflicts: 2, autoResolved: 0, remaining: 2, byType: { complex: 2 } },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  } as ConflictFile;
}

let app: App | null = null;
let container: HTMLElement;
let originalRO: typeof ResizeObserver | undefined;
const emitted: Record<string, unknown[][]> = {};

beforeEach(() => {
  localStorage.clear();
  useResolutionSelection().resetAll();
  for (const k of Object.keys(emitted)) delete emitted[k];
  aiSuggest.mockClear();
  originalRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = originalRO;
});

function mountEditor() {
  const state = reactive({ file: conflictFile() });
  const record = (name: string) => (...args: unknown[]) => {
    (emitted[name] ??= []).push(args);
  };
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(MergeEditor, {
          file: state.file,
          onResolveHunkCustom: record("resolveHunkCustom"),
          onResolve: record("resolve"),
        } as never);
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
  return state;
}

/**
 * Drain microtasks and macrotasks.
 *
 * `CodeEditor` is `defineAsyncComponent`ed (it is the entry point to ~400 KB of
 * CodeMirror), so it resolves a dynamic import before it renders. A single
 * `nextTick` is not enough to see it.
 */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Click the Nth "custom edit" action to open the edit box. */
async function openEditor(n = 0) {
  const links = [...container.querySelectorAll<HTMLAnchorElement>("a.inline-action--edit")];
  if (!links[n]) throw new Error(`no edit action #${n}; found ${links.length}`);
  links[n].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await settle();
}

/** The mounted CodeMirror editor element, or null. */
const box = () => container.querySelector<HTMLElement>(".edit-cm .cm-editor");

/** The live EditorView inside the edit box. */
async function liveView() {
  const libs = await loadCodeMirror();
  const el = box();
  return el ? libs.EditorView.findFromDOM(el) : null;
}

/** The edit box's current text. */
async function boxText(): Promise<string | null> {
  const v = await liveView();
  return v ? v.state.doc.toString() : null;
}

/** Attribute lookup on the CodeEditor host element. */
const hostAttr = (name: string) =>
  container.querySelector<HTMLElement>(".edit-cm")?.getAttribute(name) ?? null;

describe("MergeEditor — custom edit uses CodeEditor", () => {
  it("mounts a CodeEditor seeded with ours + theirs", async () => {
    mountEditor();
    expect(box(), "no editor before the action is clicked").toBeNull();

    await openEditor(0);

    expect(box(), "an editor mounts on edit").not.toBeNull();
    expect(await boxText()).toBe("ours-1\ntheirs-1");
  });

  it("passes the file path through, so the grammar can be detected", async () => {
    mountEditor();
    await openEditor(0);
    // The grammar is chosen from the file path; a .ts file must resolve one.
    const { detectLanguageExtension } = await import("../../utils/codemirrorLibs");
    expect(await detectLanguageExtension(PATH)).toHaveLength(1);
    expect(box(), "editor is mounted for this file").not.toBeNull();
  });

  it("labels the editor from i18n, not a hardcoded English literal", async () => {
    // The textarea this replaces carried `Edit conflict ${i}` inline, which was
    // a standing violation of the 5-locale rule on the line being changed.
    mountEditor();
    await openEditor(0);
    // Applied to the contenteditable, which is what a screen reader focuses.
    const content = container.querySelector<HTMLElement>(".edit-cm .cm-content");
    const label = content?.getAttribute("aria-label") ?? "";
    expect(label.length, "an aria-label is present").toBeGreaterThan(0);
    expect(content?.getAttribute("role")).toBe("textbox");
  });

  it("keeps the 8-line floor the textarea's rows=8 provided", async () => {
    mountEditor();
    await openEditor(0);
    const style = container.querySelector<HTMLElement>(".edit-cm")?.getAttribute("style") ?? "";
    expect(style, "min-lines drives a CSS floor, not an extension").toContain("8");
  });

  it("REGRESSION: confirming emits resolveHunkCustom with the edited text", async () => {
    // This flow had no coverage at all, and it is the one that writes a
    // hand-edited resolution to a real file.
    mountEditor();
    await openEditor(0);

    const view = await liveView();
    view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: "MY MANUAL RESOLUTION" } });
    await settle();

    const confirm = container.querySelector<HTMLAnchorElement>(".inline-action--validate");
    expect(confirm, "a confirm action must exist").toBeTruthy();
    confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(emitted.resolveHunkCustom, "resolveHunkCustom was emitted").toBeTruthy();
    const [path, index, content] = emitted.resolveHunkCustom[0];
    expect(path).toBe(PATH);
    expect(index).toBe(0);
    expect(content).toBe("MY MANUAL RESOLUTION");
  });

  it("cancelling emits nothing and closes the editor", async () => {
    mountEditor();
    await openEditor(0);

    const cancel = [...container.querySelectorAll<HTMLAnchorElement>(".edit-actions-inline a")]
      .find((a) => !a.className.includes("--validate"));
    expect(cancel, "a cancel action must exist").toBeTruthy();
    cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(box(), "editor closed").toBeNull();
    expect(emitted.resolveHunkCustom).toBeUndefined();
  });

  it("opening a second hunk reseeds, rather than carrying the first one's text", async () => {
    // Also why the component keys the editor on the hunk index: without it,
    // CodeMirror's undo history would survive across hunks and Cmd+Z could
    // resurrect hunk 1's text into hunk 2's write.
    mountEditor();
    await openEditor(0);
    expect(await boxText()).toBe("ours-1\ntheirs-1");

    // While a hunk's box is open its own action bar is replaced by the editor,
    // so the only edit action still on screen is the other hunk's.
    const remaining = container.querySelectorAll("a.inline-action--edit");
    expect(remaining, "one hunk is being edited, the other still offers Edit").toHaveLength(1);

    await openEditor(0);
    expect(await boxText()).toBe("ours-2\ntheirs-2");
  });
});
