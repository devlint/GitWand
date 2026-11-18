// @vitest-environment jsdom
/**
 * MergeEditor.vue — "Report" on a proposed resolution (#301, part 3): each
 * proposal panel opens the issue form with the hunk and what GitWand made of
 * it; an accepted engine or token-level proposal stays reportable from a list
 * at the top of the file until the file changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp, defineComponent, h, reactive, nextTick, ref, toRaw, type App } from "vue";
import MergeEditor from "../MergeEditor.vue";
import type { ConflictFile } from "../../composables/useGitWand";
import { useResolutionSelection } from "../../composables/useResolutionSelection";
import { CREATE_ISSUE_KEY, type CreateIssueApi } from "../../composables/useCreateIssue";

const issues = { openFromResolution: vi.fn(async () => {}), reportAvailable: ref(true) };

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

function mountWithFile(initial: ConflictFile, withIssues = true) {
  const state = reactive({ file: initial, cwd: "/repo-a" });
  const Wrapper = defineComponent({
    setup() {
      return () => h(MergeEditor, { file: state.file, cwd: state.cwd });
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(Wrapper);
  if (withIssues) app.provide(CREATE_ISSUE_KEY, issues as unknown as CreateIssueApi);
  app.mount(container);
  return state;
}


const LLM_TRACE = {
  calledAt: "2026-11-18T10:00:00Z", model: "m", latencyMs: 1, promptHash: "h",
  rawResponseTruncated: "", validationScore: 80, accepted: true,
};

function withType(file: ConflictFile, type: string, trace: object): ConflictFile {
  const h0 = { ...(file.result.hunks[0] as object), type, trace: { selected: type, steps: [], ...trace } } as never;
  const hunks = [h0, file.result.hunks[1]];
  return {
    ...file,
    result: {
      ...file.result,
      hunks,
      resolutions: file.result.resolutions.map((r, i) => ({ ...r, hunk: hunks[i] })),
    },
  } as ConflictFile;
}

const reportButtons = (panel: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(`.${panel} button`)].filter((b) => b.dataset.action === "report");
const lastCall = () => {
  const calls = issues.openFromResolution.mock.calls as unknown as unknown[][];
  return toRaw(calls[calls.length - 1]?.[0] as object);
};

describe("MergeEditor — report a resolution", () => {
  beforeEach(() => issues.openFromResolution.mockClear());

  it("the engine's preview panel reports its hunk and resolution", async () => {
    const file = twoResolvableHunks();
    mountWithFile(file);
    await nextTick();
    reportButtons("resolution-preview-panel")[0].click();
    expect(lastCall()).toEqual({ kind: "engine", path: PATH, hunk: file.result.hunks[0], resolvedLines: ["RESOLVED"] });
  });

  it("an AI proposal reports with kind ai", async () => {
    const file = withType(twoResolvableHunks(), "llm_proposed", { llmTrace: LLM_TRACE });
    mountWithFile(file);
    await nextTick();
    reportButtons("llm-trace")[0].click();
    expect(lastCall()).toMatchObject({ kind: "ai", path: PATH, resolvedLines: ["RESOLVED"] });
  });

  it("an AI proposal that failed validation can still be reported", async () => {
    const base = withType(twoResolvableHunks(), "llm_proposed", { llmTrace: { ...LLM_TRACE, accepted: false } });
    const file = {
      ...base,
      result: { ...base.result, resolutions: base.result.resolutions.map((r, i) => (i === 0 ? { ...r, resolvedLines: null, autoResolved: false } : r)) },
    } as ConflictFile;
    mountWithFile(file);
    await nextTick();
    reportButtons("llm-trace")[0].click();
    expect(lastCall()).toMatchObject({ kind: "ai", path: PATH, resolvedLines: null });
  });

  it("a token-level proposal reports its merged lines", async () => {
    const trace = { tokenMergeTrace: { mergedLines: ["M"], pass1Count: 1, pass2Count: 0, lineDetails: [] } };
    const file = withType(twoResolvableHunks(), "token_level_merge", trace);
    mountWithFile(file);
    await nextTick();
    reportButtons("token-merge-panel")[0].click();
    expect(lastCall()).toMatchObject({ kind: "token", path: PATH, resolvedLines: ["M"] });
  });

  /** The parent's re-parse after hunk 0 was written: one conflict fewer. */
  function afterWrite(file: ConflictFile): ConflictFile {
    return {
      ...file,
      result: {
        ...file.result,
        hunks: file.result.hunks.slice(1),
        resolutions: file.result.resolutions.slice(1),
        stats: { ...file.result.stats, totalConflicts: 1, autoResolved: 1 },
      },
    } as ConflictFile;
  }

  it("an accept whose write never landed lists nothing", async () => {
    mountWithFile(twoResolvableHunks());
    await nextTick();
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
  });

  it("a refused accept is not credited to the user's own later choice for that hunk", async () => {
    const file = twoResolvableHunks();
    const state = mountWithFile(file);
    await nextTick();
    // Accept: the write is refused (no reparse comes back).
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    await nextTick();
    // Reject the proposal, then keep "ours" for the same hunk.
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--reject")!.click();
    await nextTick();
    container.querySelector<HTMLAnchorElement>(".inline-action--current")!.click();
    state.file = afterWrite(file);
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
  });

  it("a whole-file write after a refused accept credits nothing", async () => {
    const file = twoResolvableHunks();
    const state = mountWithFile(file);
    await nextTick();
    // Accept: the write is refused (no reparse comes back).
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    await nextTick();
    // A file-level choice, whose reparse happens to show one conflict fewer.
    container.querySelector<HTMLButtonElement>(".me-bulk-btn")!.click();
    state.file = afterWrite(file);
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
  });

  it("another repository's file at the same path empties the list", async () => {
    const file = twoResolvableHunks();
    const state = mountWithFile(file);
    await nextTick();
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    state.file = afterWrite(file);
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(1);
    state.cwd = "/repo-b";
    state.file = twoResolvableHunks();
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
  });

  it("an accepted proposal stays reportable from the list, until the file changes", async () => {
    const file = twoResolvableHunks();
    const state = mountWithFile(file);
    await nextTick();
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    state.file = afterWrite(file);
    await nextTick();
    const rows = container.querySelectorAll(".me-accepted-item");
    expect(rows).toHaveLength(1);
    // Named by what it was, not by a line number the file has since moved past.
    expect(rows[0].textContent).toContain("non_overlapping: RESOLVED");
    rows[0].querySelector<HTMLButtonElement>("button")!.click();
    expect(lastCall()).toEqual({ kind: "engine", path: PATH, hunk: file.result.hunks[0], resolvedLines: ["RESOLVED"] });
    state.file = { ...twoResolvableHunks(), path: "other.ts" } as ConflictFile;
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
  });

  it("an undo that brings the hunk back empties the list", async () => {
    const file = twoResolvableHunks();
    const state = mountWithFile(file);
    await nextTick();
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    state.file = afterWrite(file);
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(1);
    state.file = twoResolvableHunks();
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
  });

  it("the Report button is not styled or found as Reject", async () => {
    mountWithFile(twoResolvableHunks());
    await nextTick();
    const btn = reportButtons("resolution-preview-panel")[0];
    expect(btn.classList.contains("resolution-preview-panel__btn--reject")).toBe(false);
    expect(btn.classList.contains("resolution-preview-panel__btn--report")).toBe(true);
  });

  it("offers no Report when no report could be sent", async () => {
    issues.reportAvailable.value = false;
    try {
      mountWithFile(twoResolvableHunks());
      await nextTick();
      expect(reportButtons("resolution-preview-panel")).toHaveLength(0);
    } finally {
      issues.reportAvailable.value = true;
    }
  });

  it("hides the accepted list too when no report could be sent", async () => {
    const file = twoResolvableHunks();
    const state = mountWithFile(file);
    await nextTick();
    container.querySelector<HTMLButtonElement>(".resolution-preview-panel__btn--accept")!.click();
    state.file = afterWrite(file);
    await nextTick();
    expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(1);
    issues.reportAvailable.value = false;
    try {
      await nextTick();
      expect(container.querySelectorAll(".me-accepted-item")).toHaveLength(0);
    } finally {
      issues.reportAvailable.value = true;
    }
  });

  it("offers no Report without the issue form", async () => {
    mountWithFile(twoResolvableHunks(), false);
    await nextTick();
    expect(reportButtons("resolution-preview-panel")).toHaveLength(0);
  });
});
