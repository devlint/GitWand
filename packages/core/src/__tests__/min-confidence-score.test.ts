/**
 * v3.11.0 — `minConfidenceScore`: a numeric confidence bar, 0-100.
 *
 * Until now both confidence gates in `resolver/index.ts` compared discrete
 * *labels* through `CONFIDENCE_ORDER`. The 0-100 score has existed since the
 * composite `ConfidenceScore` landed, but nothing ever compared it, so the
 * v3.11 "apply only >= 90% confidence" control had nothing to talk to.
 *
 * The load-bearing design decision is that the numeric bar is **ANDed** with
 * the label gate, never substituted for it. That is what makes it safe:
 *
 *   `complex` scores 60, not 0.
 *
 * `makeScore(100, 100, 0)` gives `100 - 100*0.40 = 60`, which is the label
 * "medium". A numeric gate that *replaced* the label gate would therefore
 * apply `complex` hunks at any bar below 60, silently, which is precisely the
 * guarantee v3.9.0 was built to establish. Because the bar can only subtract
 * from the applied set, no setting of it can ever apply more than the engine
 * applies with the bar off. `a_low_threshold_never_makes_a_complex_hunk_apply`
 * is the regression test for that, and it is the reason this option exists in
 * this shape rather than as an overload of `minConfidence`.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "../index.js";

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

/** A hunk only `ours` touched: `one_side_change`, scores 100 / "certain". */
const ONE_SIDE = conflict(["changed by ours"], ["original"], ["original"]);

/**
 * A scalar version bump on both sides: `value_only_change`, scores 83 / "high".
 * Measured, not assumed: the useful property is simply that it sits strictly
 * between the default label gate ("high") and 100, so a numeric bar can be put
 * on either side of it without the label gate ever being the thing that moves.
 */
const VALUE_ONLY = conflict(
  ['"version": "1.2.3"'],
  ['"version": "1.0.0"'],
  ['"version": "1.1.0"'],
);

/** Two genuinely incompatible edits: `complex`, scores 60 / "medium". */
const COMPLEX = conflict(["ours rewrote it"], ["original"], ["theirs rewrote it"]);

describe("minConfidenceScore — the no-op guarantee", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -10],
    ["above 100", 1000],
    ["NaN", Number.NaN],
  ])("%s leaves the result byte-identical to passing no option", (_label, value) => {
    const baseline = resolve(ONE_SIDE, "a.txt");
    const withOption = resolve(ONE_SIDE, "a.txt", {
      minConfidenceScore: value as number | null | undefined,
    });
    expect(withOption.mergedContent).toBe(baseline.mergedContent);
    expect(withOption.stats.autoResolved).toBe(baseline.stats.autoResolved);
    expect(withOption.stats.remaining).toBe(baseline.stats.remaining);
  });
});

describe("minConfidenceScore — the bar actually bites", () => {
  it("confirms the premise: the fixture scores 83, between the label gate and 100", () => {
    const hunk = resolve(VALUE_ONLY, "package.json").hunks[0];
    expect(hunk.type).toBe("value_only_change");
    expect(hunk.confidence.score).toBe(83);
    expect(hunk.confidence.label).toBe("high");
  });

  it("a bar above the hunk's score holds an otherwise auto-resolvable hunk", () => {
    const open = resolve(VALUE_ONLY, "package.json");
    expect(open.stats.autoResolved, "baseline must auto-resolve").toBe(1);

    const held = resolve(VALUE_ONLY, "package.json", { minConfidenceScore: 90 });
    expect(held.stats.autoResolved).toBe(0);
    expect(held.stats.remaining).toBe(1);
    expect(held.mergedContent).toBeNull();
  });

  it("a bar below the hunk's score leaves it applied", () => {
    const applied = resolve(VALUE_ONLY, "package.json", { minConfidenceScore: 75 });
    expect(applied.stats.autoResolved).toBe(1);
    expect(applied.mergedContent).not.toBeNull();
  });

  it("a bar exactly equal to the score applies it: the comparison is >=, not >", () => {
    const applied = resolve(VALUE_ONLY, "package.json", { minConfidenceScore: 83 });
    expect(applied.stats.autoResolved).toBe(1);
  });

  it("the label gate still applies underneath: the bar cannot rescue a low label", () => {
    // A bar of 0 is a no-op, so `complex` (label "medium", below the default
    // "high") stays refused. The two criteria are ANDed, never ORed.
    const r = resolve(COMPLEX, "a.txt", { minConfidenceScore: 0 });
    expect(r.stats.autoResolved).toBe(0);
  });

  it("the decline reason names both the score and the threshold", () => {
    const held = resolve(VALUE_ONLY, "package.json", { minConfidenceScore: 90 });
    const reason = held.resolutions[0].resolutionReason;
    expect(reason).toContain("90");
    expect(reason).toContain("83");
    expect(reason).toMatch(/minConfidenceScore/);
  });
});

describe("minConfidenceScore — the complex-scores-60 footgun", () => {
  it("confirms the premise: a complex hunk really does score 60, not 0", () => {
    const r = resolve(COMPLEX, "a.txt");
    const hunk = r.hunks[0];
    expect(hunk.type).toBe("complex");
    expect(hunk.confidence.score).toBe(60);
    expect(hunk.confidence.label).toBe("medium");
  });

  it.each([0, 10, 50, 59])(
    "a_low_threshold_never_makes_a_complex_hunk_apply (bar = %i)",
    (bar) => {
      const r = resolve(COMPLEX, "a.txt", { minConfidenceScore: bar });
      expect(r.stats.autoResolved, `bar ${bar} applied a complex hunk`).toBe(0);
      expect(r.mergedContent).toBeNull();
      expect(r.resolutions[0].resolvedLines).toBeNull();
      // The markers must survive untouched for the user to resolve by hand.
      expect(r.hunks[0].type).toBe("complex");
    },
  );

  it("the bar can only ever subtract: nothing applies that would not apply at 0", () => {
    const off = resolve(COMPLEX, "a.txt");
    const low = resolve(COMPLEX, "a.txt", { minConfidenceScore: 10 });
    expect(low.stats.autoResolved).toBeLessThanOrEqual(off.stats.autoResolved);
  });
});

describe("minConfidenceScore — v3.9.0 guarantees stay intact", () => {
  it("does not weaken the format_semantic reclassification", () => {
    // A whole-document JSON conflict: textually complex, semantically a clean
    // key merge, reclassified `format_semantic` with a score floored at 78.
    const content = conflict(
      ["{", '  "name": "app",', '  "alpha": 1', "}"],
      ["{", '  "name": "app"', "}"],
      ["{", '  "name": "app",', '  "beta": 2', "}"],
    );

    const applied = resolve(content, "config.json", { minConfidenceScore: 75 });
    expect(applied.stats.byType.format_semantic).toBe(1);
    expect(applied.stats.autoResolved, "78 >= 75 must still apply").toBe(1);

    const held = resolve(content, "config.json", { minConfidenceScore: 90 });
    expect(held.stats.autoResolved, "78 < 90 must be held back").toBe(0);
    // Held back, but still correctly classified and traced, not relabelled.
    expect(held.hunks[0].type).toBe("format_semantic");
  });
});
