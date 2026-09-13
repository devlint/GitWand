/**
 * v3.11.0 — the Conflict Predictor carries confidence, and honestly.
 *
 * Two things are pinned here.
 *
 * 1. The engine's per-hunk confidence used to be computed and thrown away.
 *    `computePreview` called `resolve`, kept `{startLine, type, autoResolved}`
 *    and dropped `confidence`, `resolvedLines` and `mergedContent`. The panel
 *    therefore could not show a score even though one existed, which is why
 *    "apply only >= 90%" had nothing to render.
 *
 * 2. The preview called `resolve`, while the real apply calls `resolveAsync`.
 *    No tree-sitter structural pass, and no options at all, so the repo's
 *    `.gitwandrc` was ignored entirely. The preview was a *lower bound* on
 *    what an apply would achieve, which is the single largest and the only
 *    fixable source of estimate-vs-actual drift.
 *
 * The preview must still never call a model: it is a read-only glance at a
 * merge that has not happened, and it must not cost money or seconds. That is
 * why `llmFallback` is asserted absent rather than merely left unset.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { resolve: number; resolveAsync: number; options: unknown[] } = {
  resolve: 0,
  resolveAsync: 0,
  options: [],
};

vi.mock("../../utils/coreEngine", () => ({
  engine: async () => {
    const core = await import("@gitwand/core");
    return {
      async resolve(c: string, p: string, o?: unknown) {
        calls.resolve++;
        return core.resolve(c, p, o as never);
      },
      async resolveAsync(c: string, p: string, o?: unknown) {
        calls.resolveAsync++;
        calls.options.push(o);
        return core.resolveAsync(c, p, o as never);
      },
      parseConflictMarkers: (c: string) => core.parseConflictMarkers(c),
    };
  },
}));

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  [
    "<<<<<<< ours",
    ...ours,
    "||||||| base",
    ...base,
    "=======",
    ...theirs,
    ">>>>>>> theirs",
  ].join("\n");

/** `value_only_change`, measured at 83. */
const SCORE_83 = conflict(
  ['  "version": "1.2.3"'],
  ['  "version": "1.0.0"'],
  ['  "version": "1.1.0"'],
);
/** `one_side_change`, measured at 100. */
const SCORE_100 = conflict(["changed by ours"], ["original"], ["original"]);

const previewRows: Array<{
  file_path: string;
  conflict_content: string;
  has_conflicts: boolean;
  is_add_delete: boolean;
}> = [];

vi.mock("../../utils/backend", () => ({
  previewMerge: async () => previewRows,
  previewRebase: async () => previewRows,
  previewCherryPick: async () => previewRows,
  readGitwandrc: async () => "",
  gitRepoState: async () => ({ state: "clean", targetBranch: null }),
}));

import { useMergePreview } from "../useMergePreview";
import { useResolutionSelection } from "../useResolutionSelection";

beforeEach(() => {
  calls.resolve = 0;
  calls.resolveAsync = 0;
  calls.options = [];
  previewRows.length = 0;
});

describe("useMergePreview — the engine call", () => {
  it("uses resolveAsync, not resolve", async () => {
    previewRows.push({
      file_path: "package.json",
      conflict_content: SCORE_83,
      has_conflicts: true,
      is_add_delete: false,
    });

    const { computePreview } = useMergePreview(() => "/repo");
    await computePreview("topic", "merge");

    expect(calls.resolveAsync, "resolveAsync must drive the preview").toBe(1);
    expect(calls.resolve, "the sync path must not be used any more").toBe(0);
  });

  it("NEVER passes llmFallback: a preview must not call a model", async () => {
    previewRows.push({
      file_path: "package.json",
      conflict_content: SCORE_83,
      has_conflicts: true,
      is_add_delete: false,
    });

    const { computePreview } = useMergePreview(() => "/repo");
    await computePreview("topic", "merge");

    expect(calls.options).toHaveLength(1);
    const opts = calls.options[0] as Record<string, unknown>;
    expect(opts).toBeTruthy();
    expect(opts.llmFallback, "no LLM in a preview").toBeUndefined();
  });

  it("tells the engine which operation is being previewed", async () => {
    previewRows.push({
      file_path: "package.json",
      conflict_content: SCORE_83,
      has_conflicts: true,
      is_add_delete: false,
    });

    const { computePreview } = useMergePreview(() => "/repo");
    await computePreview("abc123", "cherry-pick");

    const opts = calls.options[0] as { mergeContext?: { operation?: string } };
    expect(opts.mergeContext?.operation).toBe("cherry-pick");
  });
});

describe("useMergePreview — confidence reaches the summary", () => {
  it("carries the score, the label and the reason per hunk", async () => {
    previewRows.push({
      file_path: "package.json",
      conflict_content: SCORE_83,
      has_conflicts: true,
      is_add_delete: false,
    });

    const { computePreview, summary } = useMergePreview(() => "/repo");
    await computePreview("topic", "merge");

    const hunk = summary.value!.files[0].hunks[0];
    expect(hunk.confidenceScore).toBe(83);
    expect(hunk.confidenceLabel).toBe("high");
    expect(typeof hunk.reason).toBe("string");
    expect(hunk.reason.length, "the reason explains the verdict").toBeGreaterThan(0);
  });
});

describe("useMergePreview — the bar is ONE bar", () => {
  /**
   * Regression test for a bug that made the whole control cosmetic.
   *
   * The panel used to filter its displayed counts through a ref of its own
   * while `useResolutionSelection.minScore`, which is what actually gates an
   * apply, stayed 0 forever. Nothing wrote it. So a user could set 90%, watch
   * the panel report "1 held back by the bar", press Merge and auto-resolve,
   * and have the sub-90 hunk written anyway, with the apply report then
   * claiming estimate drift because the two numbers came from different
   * filters.
   *
   * Two refs for one concept cannot be kept in sync by discipline, so there is
   * now one. These assert the identity rather than the values, because values
   * can agree by accident.
   */
  it("the preview threshold IS the shared selection bar", () => {
    const { threshold } = useMergePreview(() => "/repo");
    expect(threshold, "same ref object").toBe(useResolutionSelection().minScore);
  });

  it("moving the panel bar changes what the apply would write", () => {
    const selection = useResolutionSelection();
    selection.resetAll();
    const { threshold } = useMergePreview(() => "/repo");
    const res83 = {
      autoResolved: true,
      resolvedLines: ["x"],
      hunk: { confidence: { score: 83 } },
    } as never;

    threshold.value = 0;
    expect(selection.shouldApply("a.ts", 0, res83)).toBe(true);

    threshold.value = 90;
    expect(selection.shouldApply("a.ts", 0, res83), "the apply sees the bar").toBe(false);

    threshold.value = 75;
    expect(selection.shouldApply("a.ts", 0, res83)).toBe(true);
  });
});

describe("useMergePreview — the threshold is an estimate that moves", () => {
  beforeEach(() => {
    previewRows.push(
      { file_path: "package.json", conflict_content: SCORE_83, has_conflicts: true, is_add_delete: false },
      { file_path: "a.txt", conflict_content: SCORE_100, has_conflicts: true, is_add_delete: false },
    );
  });

  it("counts every auto-resolution at a bar of 0", async () => {
    const { computePreview, threshold, estimatedAutoResolutions } = useMergePreview(() => "/repo");
    await computePreview("topic", "merge");
    threshold.value = 0;
    expect(estimatedAutoResolutions.value).toBe(2);
  });

  it("drops the 83 while keeping the 100 as the bar rises past it", async () => {
    const { computePreview, threshold, estimatedAutoResolutions, heldByThreshold } =
      useMergePreview(() => "/repo");
    await computePreview("topic", "merge");

    threshold.value = 83;
    expect(estimatedAutoResolutions.value, "the comparison is >=").toBe(2);

    threshold.value = 90;
    expect(estimatedAutoResolutions.value).toBe(1);
    expect(heldByThreshold.value, "the cost of the bar is reported").toBe(1);

    threshold.value = 100;
    expect(estimatedAutoResolutions.value).toBe(1);
  });

  it("re-reading the same summary at a new bar never re-runs the engine", async () => {
    // An interactive control re-filters on every tick; re-resolving per tick
    // is not viable, which is why the filter is a pure read over the summary.
    const { computePreview, threshold, estimatedAutoResolutions } = useMergePreview(() => "/repo");
    await computePreview("topic", "merge");
    const after = calls.resolveAsync;

    for (const bar of [0, 60, 75, 90, 95, 100]) {
      threshold.value = bar;
      void estimatedAutoResolutions.value;
    }
    expect(calls.resolveAsync).toBe(after);
  });
});
