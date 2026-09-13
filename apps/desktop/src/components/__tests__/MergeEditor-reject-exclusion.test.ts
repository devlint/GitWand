// @vitest-environment jsdom
/**
 * MergeEditor.vue — rejecting a proposed resolution must actually exclude it.
 *
 * The bug this pins (live until v3.11.0): `ResolutionPreviewPanel`'s Reject
 * only added the hunk index to a local `rejectedPreviewHunks` ref, which was
 * read by exactly one thing, the `v-if` that hides the panel. It was consulted
 * by neither `autoResolutionsSummary` nor the "Resolve auto" path, which runs
 * `resolveFile` and then `buildPartialContent` over **every** `autoResolved`
 * hunk. So rejecting a resolution hid the panel and then applied the
 * resolution anyway, with nothing reporting that it had.
 *
 * Compare `rejectedLlmHunks`, which did feed `canResolve`. The two rejection
 * paths now share one store, so they cannot diverge again.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep),
 * mirroring MergeEditor.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, defineComponent, h, reactive, nextTick, type App } from "vue";
import MergeEditor from "../MergeEditor.vue";
import type { ConflictFile } from "../../composables/useGitWand";
import { useResolutionSelection, contentStamp } from "../../composables/useResolutionSelection";

class FakeResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PATH = "src/foo.ts";

/** Two conflict blocks, both resolvable by the engine. */
const CONTENT = [
  "header",
  "<<<<<<< ours",
  "ours-0",
  "||||||| base",
  "base-0",
  "=======",
  "theirs-0",
  ">>>>>>> theirs",
  "middle",
  "<<<<<<< ours",
  "ours-1",
  "||||||| base",
  "base-1",
  "=======",
  "theirs-1",
  ">>>>>>> theirs",
  "footer",
].join("\n");

function hunk(startLine: number) {
  return {
    baseLines: [`base-${startLine}`],
    oursLines: [`ours-${startLine}`],
    theirsLines: [`theirs-${startLine}`],
    startLine,
    type: "non_overlapping",
    confidence: {
      score: 90,
      label: "high",
      dimensions: {
        typeClassification: 90, dataRisk: 20, scopeImpact: 0,
        fileFrequency: 0, baseAvailability: 0,
      },
      boosters: [],
      penalties: [],
    },
    explanation: "",
    trace: { selected: "non_overlapping", steps: [] },
  } as never;
}

function twoResolvableHunks(): ConflictFile {
  const hunks = [hunk(0), hunk(1)];
  return {
    path: PATH,
    content: CONTENT,
    result: {
      filePath: PATH,
      mergedContent: null,
      hunks,
      resolutions: hunks.map((h) => ({
        hunk: h,
        resolvedLines: ["RESOLVED"],
        autoResolved: true,
        resolutionReason: "auto",
      })),
      stats: { totalConflicts: 2, autoResolved: 2, remaining: 0, byType: { non_overlapping: 2 } },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  } as ConflictFile;
}

let app: App | null = null;
let container: HTMLElement;
let originalRO: typeof ResizeObserver | undefined;

beforeEach(() => {
  localStorage.clear();
  useResolutionSelection().resetAll();
  useResolutionSelection().minScore.value = 0;
  originalRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = originalRO;
});

function mountWithFile(initial: ConflictFile) {
  const state = reactive({ file: initial });
  const Wrapper = defineComponent({
    setup() {
      return () => h(MergeEditor, { file: state.file });
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  app.mount(container);
  return state;
}

/** How many ResolutionPreviewPanels are currently rendered. */
function panelCount(): number {
  return container.querySelectorAll(".resolution-preview-panel").length;
}

/** Click the Reject button of the Nth rendered ResolutionPreviewPanel. */
function rejectNth(n: number): void {
  const btn = container.querySelectorAll<HTMLButtonElement>(
    ".resolution-preview-panel__btn--reject",
  )[n];
  if (!btn) throw new Error(`no reject button #${n}; found ${panelCount()} panels`);
  btn.click();
}

describe("MergeEditor — rejecting a resolution excludes it from the apply", () => {
  it("renders a resolution preview per auto-resolved hunk", async () => {
    mountWithFile(twoResolvableHunks());
    await nextTick();
    expect(panelCount()).toBe(2);
  });

  it("REGRESSION: rejecting hunk 0 records it in the shared selection store", async () => {
    mountWithFile(twoResolvableHunks());
    await nextTick();

    const selection = useResolutionSelection();
    const stamp = contentStamp(CONTENT);
    expect(selection.isExcluded(PATH, 0, stamp)).toBe(false);

    rejectNth(0);
    await nextTick();

    // The whole point: the rejection must be visible to the code that applies,
    // not only to the `v-if` that hides the panel.
    expect(selection.isExcluded(PATH, 0, stamp), "rejection reached the store").toBe(true);
    expect(selection.isExcluded(PATH, 1, stamp), "other hunks untouched").toBe(false);
  });

  it("a rejected hunk is not offered to the apply predicate", async () => {
    mountWithFile(twoResolvableHunks());
    await nextTick();
    rejectNth(0);
    await nextTick();

    const selection = useResolutionSelection();
    const stamp = contentStamp(CONTENT);
    const resolutions = twoResolvableHunks().result.resolutions;

    expect(selection.shouldApply(PATH, 0, resolutions[0] as never, stamp)).toBe(false);
    expect(selection.shouldApply(PATH, 1, resolutions[1] as never, stamp)).toBe(true);
  });

  it("hides the rejected hunk's panel, as it always did", async () => {
    mountWithFile(twoResolvableHunks());
    await nextTick();
    rejectNth(0);
    await nextTick();
    expect(panelCount()).toBe(1);
  });

  it("another file gets its own panels, and coming back keeps the rejection", async () => {
    // The selection is keyed by path and guarded by a content stamp, so it is
    // deliberately NOT cleared on a file switch: tabbing between two
    // conflicted files must not silently discard what the user ticked off.
    const first = twoResolvableHunks();
    const state = mountWithFile(first);
    await nextTick();
    rejectNth(0);
    await nextTick();
    expect(panelCount()).toBe(1);

    const other = twoResolvableHunks();
    (other as { path: string }).path = "src/other.ts";
    state.file = other;
    await nextTick();
    expect(panelCount(), "the other file is unaffected").toBe(2);

    state.file = twoResolvableHunks();
    await nextTick();
    expect(panelCount(), "coming back preserves the rejection").toBe(1);
  });

  it("a content change invalidates the rejection rather than misapplying it", async () => {
    // Positional indices cannot survive an edit we did not make, so the safe
    // failure is to forget the selection, not to point it at another hunk.
    const state = mountWithFile(twoResolvableHunks());
    await nextTick();
    rejectNth(0);
    await nextTick();
    expect(panelCount()).toBe(1);

    const edited = twoResolvableHunks();
    (edited as { content: string }).content = "someone else edited this file\n" + CONTENT;
    state.file = edited;
    await nextTick();

    expect(panelCount(), "stale selection dropped, everything re-offered").toBe(2);
  });
});
