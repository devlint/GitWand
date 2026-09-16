// @vitest-environment jsdom
/**
 * Issue #196: the AI action gave almost no feedback while it ran, and nothing
 * stopped a second click landing on another hunk mid-flight. This guards the
 * two visible halves of the fix: a hunk that is working shows it and refuses
 * further clicks, and a suggestion lands in the hunk it belongs to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import type { ConflictFile } from "../../composables/useGitWand";
import type { ConflictHunk } from "@gitwand/core";
import { loadCodeMirror } from "../../utils/codemirrorLibs";
import { installCodeMirrorDomShims } from "../../test-utils/codemirrorDom";

// The edit box autofocuses on open, which makes CodeMirror measure the
// cursor, which jsdom cannot do without this shim. See the helper for why it
// is opted into per-file rather than globally.
installCodeMirrorDomShims();

const suggest = vi.fn();
vi.mock("../../composables/useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: { value: true },
    isLoading: { value: false },
    lastError: { value: null },
    suggest,
  }),
}));

import MergeEditor from "../MergeEditor.vue";

function complexHunk(n: number): ConflictHunk {
  return {
    baseLines: [`base${n}`],
    oursLines: [`ours${n}`],
    theirsLines: [`theirs${n}`],
    startLine: n + 1,
    type: "complex",
    confidence: {
      score: 20,
      label: "low",
      dimensions: { typeClassification: 20, dataRisk: 80, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 },
      boosters: [],
      penalties: [],
    },
    explanation: "manual resolution required",
    trace: { steps: [], selected: "complex", summary: "test", hasBase: true },
  } as unknown as ConflictHunk;
}

/**
 * Build the same `ConflictFile` shape the other MergeEditor tests use. Copied
 * from `MergeEditor-ai-sparkle.test.ts` rather than inventing a new one, so
 * all the merge-editor tests fail together if that shape changes.
 */
function fileWith(hunks: ConflictHunk[]): ConflictFile {
  const content = hunks
    .map((hunk, i) => [
      `line before ${i}`,
      "<<<<<<< ours",
      ...hunk.oursLines,
      "=======",
      ...hunk.theirsLines,
      ">>>>>>> theirs",
      `line after ${i}`,
    ].join("\n"))
    .join("\n");
  return {
    path: "src/foo.ts",
    content,
    result: {
      filePath: "src/foo.ts",
      mergedContent: null,
      hunks,
      resolutions: hunks.map((hunk) => ({ hunk, resolvedLines: null, autoResolved: false, resolutionReason: "test" })),
      stats: { totalConflicts: hunks.length, autoResolved: 0, byType: { complex: hunks.length } },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

/**
 * Drain microtasks and macrotasks. `CodeEditor` is `defineAsyncComponent`ed
 * (the entry point to ~400 KB of CodeMirror), so it resolves a dynamic import
 * before it renders; a single `nextTick` is not enough to see it mount.
 */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("MergeEditor AI queue", () => {
  let app: App | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    suggest.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    host.remove();
  });

  it("disables a hunk's AI action while that hunk is working", async () => {
    let release!: (v: unknown) => void;
    suggest.mockReturnValue(new Promise((res) => { release = res; }));

    const resolveHunk = vi.fn();
    app = createApp(MergeEditor, {
      file: fileWith([complexHunk(0), complexHunk(1)]),
      cwd: "/repo",
      onResolveHunk: resolveHunk,
    });
    app.mount(host);
    await nextTick();

    const aiLinks = [...host.querySelectorAll(".inline-action--ai")] as HTMLElement[];
    expect(aiLinks.length).toBeGreaterThanOrEqual(2);

    aiLinks[0].click();
    await nextTick();

    expect(aiLinks[0].className).toContain("inline-action--loading");
    expect(aiLinks[0].getAttribute("aria-disabled")).toBe("true");
    // A second click on the same hunk must not reach the provider again.
    aiLinks[0].click();
    await nextTick();
    expect(suggest).toHaveBeenCalledTimes(1);

    // The whole row is disabled while a hunk is working, not just its own AI
    // entry: otherwise a user could accept hunk 0 while its suggestion is
    // still arriving, and the answer would land in an editor opened on a
    // hunk that was already resolved.
    const current = [...host.querySelectorAll("a.inline-action--current")] as HTMLElement[];
    const incoming = [...host.querySelectorAll("a.inline-action--incoming")] as HTMLElement[];
    const both = [...host.querySelectorAll("a.inline-action--both")] as HTMLElement[];
    const edit = [...host.querySelectorAll("a.inline-action--edit")] as HTMLElement[];
    const explain = [...host.querySelectorAll("a.inline-action--explain")] as HTMLElement[];
    for (const row of [current, incoming, both, edit, explain]) {
      expect(row[0].getAttribute("aria-disabled")).toBe("true");
      // Busy hunk 0 must not affect hunk 1's own row.
      expect(row[1].getAttribute("aria-disabled")).toBe("false");
    }

    // A click on a disabled row action must not reach the emit either, not
    // just look disabled: `pointer-events: none` only stops a real pointer,
    // not a direct dispatch, so the guard has to live in the handler too.
    current[0].click();
    await nextTick();
    expect(resolveHunk).not.toHaveBeenCalled();

    release({ resolvedContent: "merged", explanation: "why", confidence: "high" });
  });

  it("keeps a hunk's busy state and its own suggestion isolated when another hunk is also requested", async () => {
    // Two independent pending calls, resolved out of request order below, so
    // this cannot pass by accident of timing.
    let release0!: (v: unknown) => void;
    let release1!: (v: unknown) => void;
    let call = 0;
    suggest.mockImplementation(() => new Promise((res) => {
      call += 1;
      if (call === 1) release0 = res;
      else release1 = res;
    }));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const aiLinks = [...host.querySelectorAll<HTMLElement>(".inline-action--ai")];
    expect(aiLinks.length).toBeGreaterThanOrEqual(2);

    aiLinks[0].click();
    await nextTick();
    // Ask on hunk 1 too while hunk 0 is still in flight. Against the old
    // shared `aiSuggestionHunkIndex` ref this cleared hunk 0's own busy
    // indicator, even though hunk 0's request was still pending underneath,
    // which both let a user re-request hunk 0 and hid that it was still
    // working.
    aiLinks[1].click();
    await nextTick();

    expect(aiLinks[0].className, "hunk 0 stays marked busy").toContain("inline-action--loading");
    expect(aiLinks[0].getAttribute("aria-disabled")).toBe("true");

    // Resolve hunk 1's (the second, not the first, request) and check the
    // answer lands in hunk 1's own editor. Targeting hunk 1 here, not hunk 0,
    // means an implementation that quietly defaults to the first or last
    // hunk index fails this assertion instead of passing by accident.
    release1({ resolvedContent: "SUGGESTED FOR HUNK 1", explanation: "why", confidence: "high" });
    await settle();

    const box = host.querySelector<HTMLElement>(".edit-cm .cm-editor");
    expect(box, "an editor opened").not.toBeNull();
    const libs = await loadCodeMirror();
    const view = libs.EditorView.findFromDOM(box!);
    expect(view?.state.doc.toString()).toBe("SUGGESTED FOR HUNK 1");

    // Hunk 0's own request is still pending and must be unaffected by hunk 1
    // having resolved in the meantime.
    expect(aiLinks[0].className, "hunk 0 still busy after hunk 1 resolved").toContain("inline-action--loading");

    release0({ resolvedContent: "SUGGESTED FOR HUNK 0", explanation: "why", confidence: "high" });
    await settle();
  });
});
