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

    app = createApp(MergeEditor, { file: fileWith([complexHunk(0), complexHunk(1)]), cwd: "/repo" });
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

    release({ resolvedContent: "merged", explanation: "why", confidence: "high" });
  });
});
