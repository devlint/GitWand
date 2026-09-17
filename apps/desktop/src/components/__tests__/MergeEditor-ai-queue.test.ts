// @vitest-environment jsdom
/**
 * Issue #196: the AI action gave almost no feedback while it ran, and nothing
 * stopped a second click landing on another hunk mid-flight. This guards the
 * two visible halves of the fix: a hunk that is working shows it and refuses
 * further clicks, and a suggestion lands in the hunk it belongs to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
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


/** The shape `useAIProvider.suggest` resolves with. */
const answer = (text: string) => ({ resolvedContent: text, explanation: "why", confidence: "high" as const });

/**
 * A file whose hunks at `resolvedIndices` were already resolved by the
 * engine, which is what `showResolutionPreviewFor` keys on to hide their
 * action row.
 */
function fileWithAutoResolved(hunks: ConflictHunk[], resolvedIndices: number[]): ConflictFile {
  const file = fileWith(hunks);
  const resolutions = file.result.resolutions as unknown as Array<Record<string, unknown>>;
  for (const i of resolvedIndices) {
    resolutions[i] = {
      hunk: hunks[i],
      resolvedLines: [`engine merge ${i}`],
      autoResolved: true,
      resolutionReason: "engine",
    };
  }
  return file;
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

  it("stages every unresolved hunk and applies nothing", async () => {
    suggest.mockResolvedValue({ resolvedContent: "merged", explanation: "why", confidence: "high" });

    const file = fileWith([complexHunk(0), complexHunk(1), complexHunk(2)]);
    // `mergedContent` is `MergeResult`'s actual field (there is no `.merged`);
    // captured before the click and compared against itself, since a
    // freshly-built one-hunk file would differ by construction anyway.
    const before = file.result.mergedContent;
    app = createApp(MergeEditor, { file, cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const bulkAi = host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    expect(bulkAi).toBeTruthy();
    bulkAi.click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(3));

    // Staged, not applied: the file's merged content is untouched.
    expect(file.result.mergedContent).toBe(before);
  });

  it("offers a cancel while the batch runs", async () => {
    suggest.mockReturnValue(new Promise(() => {}));
    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await nextTick();

    const btn = host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    expect(btn.textContent).toContain("Cancel");
  });

  it("restarts a fresh batch after a cancel", async () => {
    // Cancel is only reachable from the UI once the bulk AI entry exists;
    // nothing before Task 4 proved the queue actually runs again afterward.
    const releases: Array<(v: unknown) => void> = [];
    suggest.mockImplementation(() => new Promise((res) => { releases.push(res); }));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const bulkAi = () => host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    bulkAi().click();
    await nextTick();
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(bulkAi().textContent).toContain("Cancel");

    // Cancel mid-flight, then let the now-stale calls settle: a cancelled
    // run's generation no longer matches, so this must not resurrect either
    // hunk's suggestion.
    bulkAi().click();
    await nextTick();
    releases[0]({ resolvedContent: "stale", explanation: "why", confidence: "high" });
    releases[1]({ resolvedContent: "stale", explanation: "why", confidence: "high" });
    await nextTick();
    expect(bulkAi().textContent).not.toContain("Cancel");

    // A second batch must really run the provider again, not silently no-op.
    suggest.mockReset();
    suggest.mockResolvedValue({ resolvedContent: "merged", explanation: "why", confidence: "high" });
    bulkAi().click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(bulkAi().textContent).not.toContain("Cancel"));
  });


  it("surfaces a staged suggestion on the hunk's own row once the batch is over", async () => {
    // A batch leaves no hunk in edit mode, and both places that rendered a
    // ready suggestion were gated on the editor being open for that hunk, so
    // three model calls used to buy nothing the user could see.
    suggest.mockImplementation((ctx: { ours: string }) => Promise.resolve(answer(`merged for ${ctx.ours}`)));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    await settle();

    const staged = [...host.querySelectorAll<HTMLElement>(".ai-staged-banner")];
    expect(staged.length, "every hunk that got an answer shows it").toBe(2);

    // Opening one uses the stored answer. A second model call for something
    // already paid for is the other half of the bug.
    (staged[1].querySelector(".ai-staged-review") as HTMLElement).click();
    await settle();
    expect(suggest).toHaveBeenCalledTimes(2);

    const box = host.querySelector<HTMLElement>(".edit-cm .cm-editor");
    expect(box, "the editor opened on the staged suggestion").not.toBeNull();
    const libs = await loadCodeMirror();
    expect(libs.EditorView.findFromDOM(box!)?.state.doc.toString()).toBe("merged for ours1");
  });

  it("opens a staged answer from the hunk's AI action instead of asking again", async () => {
    suggest.mockImplementation((ctx: { ours: string }) => Promise.resolve(answer(`merged for ${ctx.ours}`)));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    await settle();

    (host.querySelectorAll<HTMLElement>(".inline-action--ai")[0]).click();
    await settle();

    expect(suggest, "a staged answer is opened, not re-bought").toHaveBeenCalledTimes(2);
    const box = host.querySelector<HTMLElement>(".edit-cm .cm-editor");
    const libs = await loadCodeMirror();
    expect(libs.EditorView.findFromDOM(box!)?.state.doc.toString()).toBe("merged for ours0");
  });

  it("discards a staged suggestion without opening it", async () => {
    suggest.mockResolvedValue(answer("merged"));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    await settle();

    (host.querySelector(".ai-staged-discard") as HTMLElement).click();
    await settle();
    expect(host.querySelector(".ai-staged-banner")).toBeNull();
    expect(host.querySelector(".hunk-edit")).toBeNull();
  });

  it("opens the retry after the call it replaced answers late", async () => {
    // A cancelled run used to settle whatever promise a newer request for the
    // same hunk had registered, so the caller woke up on the stale answer,
    // read the hunk as still loading and opened nothing.
    const releases: Array<(v: unknown) => void> = [];
    suggest.mockImplementation(() => new Promise((res) => { releases.push(res); }));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const bulkAi = () => host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    bulkAi().click();
    await nextTick();
    expect(suggest).toHaveBeenCalledTimes(2);
    bulkAi().click();
    await nextTick();

    (host.querySelectorAll<HTMLElement>(".inline-action--ai")[0]).click();
    await nextTick();
    expect(suggest).toHaveBeenCalledTimes(3);

    releases[0](answer("STALE"));
    await settle();
    expect(host.querySelector(".hunk-edit"), "the stale answer must not count as the retry").toBeNull();

    releases[2](answer("FRESH"));
    await settle();
    const box = host.querySelector<HTMLElement>(".edit-cm .cm-editor");
    expect(box, "the retry opens when its own call answers").not.toBeNull();
    const libs = await loadCodeMirror();
    expect(libs.EditorView.findFromDOM(box!)?.state.doc.toString()).toBe("FRESH");
  });

  it("does not re-arm the bulk cancel for a request made after the batch ended", async () => {
    // Batch membership used to outlive the batch, so a later per-hunk request
    // on a hunk that happened to be in it turned the bulk button back into a
    // cancel, which would then kill that unrelated request.
    suggest.mockImplementation((ctx: { ours: string }) =>
      ctx.ours === "ours1" ? Promise.reject(new Error("model said no")) : Promise.resolve(answer("ok")),
    );

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const bulkAi = () => host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    bulkAi().click();
    await settle();
    expect(bulkAi().textContent).not.toContain("Cancel");
    // The split is still reported once the membership is gone.
    expect(host.querySelector(".me-bulk-ai-summary")?.textContent).toContain("1 resolved, 1 failed");

    suggest.mockReturnValue(new Promise(() => {}));
    (host.querySelectorAll<HTMLElement>(".inline-action--ai")[1]).click();
    await settle();

    expect(bulkAi().textContent, "a lone per-hunk request is not a batch").not.toContain("Cancel");
  });

  it("resets per-hunk AI state when the hunks are re-parsed under the same path", async () => {
    // Resolving one conflict renumbers every later one, and the parent hands
    // back a new result under the SAME path, so a watcher on the path alone
    // never fires and the old indices keep pointing at the wrong hunks.
    suggest.mockResolvedValue(answer("merged"));

    const file = ref(fileWith([complexHunk(0), complexHunk(1), complexHunk(2)]));
    app = createApp({ render: () => h(MergeEditor, { file: file.value, cwd: "/repo" }) });
    app.mount(host);
    await nextTick();

    (host.querySelectorAll<HTMLElement>(".inline-action--ai")[0]).click();
    await settle();
    expect(host.querySelector(".ai-explanation-banner")).not.toBeNull();

    file.value = fileWith([complexHunk(1), complexHunk(2)]);
    await settle();

    expect(host.querySelector(".hunk-edit"), "an open edit box must not survive a re-parse").toBeNull();
    expect(
      host.querySelector(".ai-explanation-banner"),
      "one hunk's explanation must not be re-attributed to another",
    ).toBeNull();
    expect(host.querySelector(".ai-staged-banner"), "no suggestion survives the renumbering").toBeNull();
  });

  it("runs a fresh batch after the hunks were renumbered", async () => {
    // Falls out of the reset above: without it every surviving index still
    // reads `ready`, so the batch filters everything out and the button
    // silently does nothing.
    suggest.mockResolvedValue(answer("merged"));

    const file = ref(fileWith([complexHunk(0), complexHunk(1)]));
    app = createApp({ render: () => h(MergeEditor, { file: file.value, cwd: "/repo" }) });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    await settle();

    file.value = fileWith([complexHunk(1)]);
    await settle();

    suggest.mockClear();
    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  });

  it("does not ask the model about hunks the engine already resolved", async () => {
    suggest.mockResolvedValue(answer("merged"));

    const file = fileWithAutoResolved(
      [complexHunk(0), complexHunk(1), complexHunk(2), complexHunk(3)],
      [1, 2, 3],
    );
    app = createApp(MergeEditor, { file, cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await settle();

    expect(suggest, "only the hunk that still needs a human is paid for").toHaveBeenCalledTimes(1);
  });

  it("labels a plain custom edit as a custom edit even when a suggestion is staged", async () => {
    suggest.mockResolvedValue(answer("AI CONTENT"));

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    (host.querySelector(".inline-action--ai") as HTMLElement).click();
    await settle();
    expect(host.querySelector(".edit-label")?.textContent).toContain("AI suggestion");

    // Close it and reopen the SAME hunk through Custom edit. The box now
    // holds `startEditing`'s ours-plus-theirs concatenation, so calling it an
    // AI suggestion and showing the model's explanation under it is a lie.
    ([...host.querySelectorAll<HTMLElement>(".edit-actions-inline .inline-action")].pop() as HTMLElement).click();
    await settle();
    (host.querySelector(".inline-action--edit") as HTMLElement).click();
    await settle();

    expect(host.querySelector(".edit-label")?.textContent).not.toContain("AI");
    expect(host.querySelector(".ai-explanation-banner")).toBeNull();
  });

  it("keeps the other staged suggestions, renumbered, when one hunk is confirmed", async () => {
    // Confirming one hunk renumbers the rest, and the blanket reset above
    // threw away every answer the batch had already paid for, so a user who
    // resolved the first of ten hunks had to buy the other nine again.
    suggest.mockImplementation((ctx: { ours: string }) => Promise.resolve(answer(`merged for ${ctx.ours}`)));

    const file = ref(fileWith([complexHunk(0), complexHunk(1), complexHunk(2)]));
    app = createApp({ render: () => h(MergeEditor, { file: file.value, cwd: "/repo" }) });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(3));
    await settle();
    expect(host.querySelectorAll(".ai-staged-banner").length).toBe(3);

    // Confirm hunk 0 the way a user does: open its staged answer, validate it.
    (host.querySelectorAll<HTMLElement>(".ai-staged-review")[0]).click();
    await settle();
    (host.querySelector(".inline-action--validate") as HTMLElement).click();
    await settle();

    // What the parent hands back: the same path, one conflict fewer, the two
    // survivors now at 0 and 1.
    file.value = fileWith([complexHunk(1), complexHunk(2)]);
    await settle();

    const staged = [...host.querySelectorAll<HTMLElement>(".ai-staged-banner")];
    expect(staged.length, "answers already paid for survive the renumbering").toBe(2);

    // And each survivor carries the answer bought for ITS hunk, not its old
    // neighbour's, which is the failure a plain carry-over would produce.
    staged[0].querySelector<HTMLElement>(".ai-staged-review")!.click();
    await settle();
    const box = host.querySelector<HTMLElement>(".edit-cm .cm-editor");
    const libs = await loadCodeMirror();
    expect(libs.EditorView.findFromDOM(box!)?.state.doc.toString()).toBe("merged for ours1");
    expect(suggest, "nothing was re-bought").toHaveBeenCalledTimes(3);
  });

  it("drops every staged suggestion when a file-wide resolve renumbers the hunks", async () => {
    suggest.mockImplementation((ctx: { ours: string }) => Promise.resolve(answer(`merged for ${ctx.ours}`)));

    const file = ref(fileWith([complexHunk(0), complexHunk(1)]));
    app = createApp({ render: () => h(MergeEditor, { file: file.value, cwd: "/repo" }) });
    app.mount(host);
    await nextTick();

    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    await settle();

    // "Keep ours" on the whole file. No hunk index describes what that
    // consumed, so the renumbering cannot be derived and the reset stands —
    // even though the hunk count then drops by exactly one, which is the
    // same shape a single-hunk resolution has.
    (host.querySelectorAll<HTMLElement>(".me-bulk-btn")[0]).click();
    await settle();
    file.value = fileWith([complexHunk(1)]);
    await settle();

    expect(host.querySelector(".ai-staged-banner"), "no answer may be re-attributed").toBeNull();
    // And the survivor is askable again, rather than stuck reading `ready`.
    suggest.mockClear();
    (host.querySelector(".me-bulk-btn--ai") as HTMLElement).click();
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  });

  it("does not mistake a lone per-hunk AI request for a running batch", async () => {
    // The queue is file-wide and is also driven by each hunk's own AI
    // action, so the bulk bar must track its own batch membership: without
    // that, a single per-hunk request in flight makes `isRunning` true while
    // nothing was ever queued through the bulk button, and the bulk button
    // (wired to cancel while "running") would silently cancel a request the
    // user never associated with a batch.
    suggest.mockReturnValue(new Promise(() => {}));
    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
    app.mount(host);
    await nextTick();

    const aiLink = host.querySelector(".inline-action--ai") as HTMLElement;
    aiLink.click();
    await nextTick();

    const bulkAi = host.querySelector(".me-bulk-btn--ai") as HTMLElement;
    expect(bulkAi.textContent).not.toContain("Cancel");
    expect(bulkAi.textContent).not.toMatch(/-\d/);
  });
});
