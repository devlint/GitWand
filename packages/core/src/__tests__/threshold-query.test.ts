/**
 * v3.11.0 — the agreement contract between the engine's numeric gate and the
 * pure `wouldApplyAtThreshold` query.
 *
 * The desktop deliberately does NOT pass `minConfidenceScore` into the worker.
 * An interactive confidence control re-filters on every tick, and re-running
 * `resolve()` per tick is not viable, so the UI filters an already-computed
 * `MergeResult` with the pure query instead.
 *
 * That is only sound because the two genuinely agree, which in turn is only
 * true because the bar is ANDed with the label gate and can only subtract:
 *
 *     engine applies at X   <=>   engine applies at 0   AND   score >= X
 *
 * If anyone later makes the numeric gate a *replacement* for the label gate,
 * or lets it widen the applied set, this file is what fails.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "../index.js";
import { summarizeAtThreshold, wouldApplyAtThreshold } from "../stats/threshold.js";

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

/** A spread of hunk kinds and scores in one file, plus plain context. */
const CORPUS: Array<{ path: string; content: string }> = [
  {
    path: "one-side.txt",
    content: conflict(["changed by ours"], ["original"], ["original"]),
  },
  {
    path: "same.txt",
    content: conflict(["same"], ["original"], ["same"]),
  },
  {
    path: "package.json",
    content: conflict(['"version": "1.2.3"'], ['"version": "1.0.0"'], ['"version": "1.1.0"']),
  },
  {
    path: "complex.txt",
    content: conflict(["ours rewrote it"], ["original"], ["theirs rewrote it"]),
  },
  {
    path: "multi.txt",
    content: [
      "header",
      conflict(["changed by ours"], ["original"], ["original"]),
      "middle",
      conflict(["ours rewrote it"], ["original"], ["theirs rewrote it"]),
      "footer",
    ].join("\n"),
  },
];

const BARS = [0, 25, 50, 60, 61, 75, 83, 84, 90, 92, 100];

describe("threshold query agrees with the engine gate", () => {
  it.each(CORPUS)("$path", ({ path, content }) => {
    const open = resolve(content, path);

    // Whole-file retraction (a broken format invariant, or an invalid parse
    // tree) legitimately diverges: it withdraws resolutions the per-hunk query
    // knows nothing about. Documented, and skipped rather than papered over.
    if (open.validation.invariantErrors?.length) return;

    for (const bar of BARS) {
      const gated = resolve(content, path, { minConfidenceScore: bar });
      expect(
        gated.resolutions.length,
        `bar ${bar} changed the hunk count for ${path}`,
      ).toBe(open.resolutions.length);

      for (let i = 0; i < open.resolutions.length; i++) {
        const engineApplied =
          gated.resolutions[i].autoResolved && gated.resolutions[i].resolvedLines !== null;
        const queryApplied = wouldApplyAtThreshold(open.resolutions[i], bar);
        expect(
          queryApplied,
          `${path} hunk ${i} at bar ${bar}: engine=${engineApplied} query=${queryApplied} ` +
            `(score ${open.resolutions[i].hunk.confidence.score}, type ${open.resolutions[i].hunk.type})`,
        ).toBe(engineApplied);
      }
    }
  });
});

describe("summarizeAtThreshold", () => {
  it("splits into applied / held-by-the-bar / manual, summing to the hunk count", () => {
    const content = [
      conflict(["changed by ours"], ["original"], ["original"]),
      conflict(['"version": "1.2.3"'], ['"version": "1.0.0"'], ['"version": "1.1.0"']),
      conflict(["ours rewrote it"], ["original"], ["theirs rewrote it"]),
    ].join("\nmiddle\n");
    const r = resolve(content, "package.json");

    const off = summarizeAtThreshold(r, 0);
    expect(off.heldByThreshold, "a bar of 0 holds nothing back").toBe(0);
    expect(off.applied + off.manual).toBe(r.resolutions.length);

    const high = summarizeAtThreshold(r, 90);
    expect(high.applied + high.heldByThreshold + high.manual).toBe(r.resolutions.length);
    // Raising the bar moves hunks from `applied` into `heldByThreshold` only.
    expect(high.manual).toBe(off.manual);
    expect(high.applied).toBeLessThanOrEqual(off.applied);
    expect(high.heldByThreshold).toBe(off.applied - high.applied);
  });

  it("never counts an engine-declined hunk as held by the bar", () => {
    // `complex` is declined by the engine itself, so it is `manual` at every
    // bar. Reporting it as "held back by your 90% setting" would tell the user
    // that lowering the bar would apply it, which is false.
    const r = resolve(conflict(["ours rewrote it"], ["original"], ["theirs rewrote it"]), "a.txt");
    for (const bar of BARS) {
      const s = summarizeAtThreshold(r, bar);
      expect(s.manual, `bar ${bar}`).toBe(1);
      expect(s.heldByThreshold, `bar ${bar}`).toBe(0);
    }
  });
});
