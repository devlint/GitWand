/**
 * v3.11.0 — per-hunk opt-out and the global confidence bar.
 *
 * The hard part here is not the set, it is index drift. Every apply primitive
 * in the app addresses a conflict by its positional index within the file
 * (`buildPartialContent`, `replaceConflictByIndex`, `resolveHunkCustom`), so
 * once a filtered apply removes some blocks the surviving ones renumber, and a
 * stale exclusion silently excludes the *wrong* hunk. That is a worse failure
 * than losing the selection, because it is invisible.
 *
 * Hence two rules, both pinned below:
 *   - after an apply we remap deterministically, since we know exactly which
 *     indices were consumed;
 *   - after any *other* content change we fail closed and drop the file's
 *     entry, which re-ticks everything. Visibly wrong-but-safe beats silently
 *     wrong.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  useResolutionSelection,
  contentStamp,
  type SelectableResolution,
} from "../useResolutionSelection";

/** Minimal stand-in for a core `HunkResolution`. */
const res = (score: number, applied = true): SelectableResolution => ({
  autoResolved: applied,
  resolvedLines: applied ? ["x"] : null,
  hunk: { confidence: { score } },
});

describe("useResolutionSelection", () => {
  beforeEach(() => {
    useResolutionSelection().resetAll();
    useResolutionSelection().minScore.value = 0;
  });

  it("is a module-level singleton: every caller sees the same set", () => {
    const a = useResolutionSelection();
    const b = useResolutionSelection();
    a.toggle("f.ts", 2, "stamp");
    expect(b.isExcluded("f.ts", 2)).toBe(true);
  });

  it("applies by default and excludes once toggled", () => {
    const s = useResolutionSelection();
    expect(s.shouldApply("f.ts", 0, res(90))).toBe(true);
    s.toggle("f.ts", 0, "stamp");
    expect(s.shouldApply("f.ts", 0, res(90))).toBe(false);
    s.toggle("f.ts", 0, "stamp");
    expect(s.shouldApply("f.ts", 0, res(90))).toBe(true);
  });

  it("never applies what the engine itself declined, toggle or no toggle", () => {
    const s = useResolutionSelection();
    expect(s.shouldApply("f.ts", 0, res(100, false))).toBe(false);
    expect(s.shouldApply("f.ts", 0, { ...res(100), resolvedLines: null })).toBe(false);
  });

  it("honours the global confidence bar", () => {
    const s = useResolutionSelection();
    s.minScore.value = 90;
    expect(s.shouldApply("f.ts", 0, res(83))).toBe(false);
    expect(s.shouldApply("f.ts", 0, res(90)), "the comparison is >=").toBe(true);
    expect(s.shouldApply("f.ts", 0, res(92))).toBe(true);
  });

  it("the bar and the per-hunk opt-out are independent: either one can refuse", () => {
    const s = useResolutionSelection();
    s.minScore.value = 50;
    s.toggle("f.ts", 1, "stamp");
    expect(s.shouldApply("f.ts", 0, res(99))).toBe(true);
    expect(s.shouldApply("f.ts", 1, res(99)), "excluded despite a high score").toBe(false);
    expect(s.shouldApply("f.ts", 2, res(10)), "below the bar despite no toggle").toBe(false);
  });

  it("keeps files independent", () => {
    const s = useResolutionSelection();
    s.toggle("a.ts", 0, "stamp");
    expect(s.isExcluded("a.ts", 0)).toBe(true);
    expect(s.isExcluded("b.ts", 0)).toBe(false);
  });
});

describe("useResolutionSelection — index drift after a filtered apply", () => {
  beforeEach(() => useResolutionSelection().resetAll());

  it("renumbers survivors: exclude 1 and 3 of 5, apply 0/2/4", () => {
    const s = useResolutionSelection();
    s.toggle("f.ts", 1, "old");
    s.toggle("f.ts", 3, "old");

    // Hunks 0, 2 and 4 were written to disk and are gone. The file now holds
    // the old hunks 1 and 3, which have become 0 and 1.
    s.remapAfterApply("f.ts", [0, 2, 4], "new");

    expect(s.isExcluded("f.ts", 0), "old 1 became 0").toBe(true);
    expect(s.isExcluded("f.ts", 1), "old 3 became 1").toBe(true);
    expect(s.isExcluded("f.ts", 2)).toBe(false);
  });

  it("drops an exclusion whose hunk was applied anyway", () => {
    // Defensive: if something applied an excluded hunk, the exclusion has no
    // surviving hunk to point at and must not land on an unrelated one.
    const s = useResolutionSelection();
    s.toggle("f.ts", 0, "old");
    s.toggle("f.ts", 2, "old");
    s.remapAfterApply("f.ts", [0, 1], "new");
    expect(s.isExcluded("f.ts", 0), "old 2 is the only survivor, now index 0").toBe(true);
    expect(s.isExcluded("f.ts", 1)).toBe(false);
  });

  it("applying nothing leaves the selection untouched", () => {
    const s = useResolutionSelection();
    s.toggle("f.ts", 2, "old");
    s.remapAfterApply("f.ts", [], "old");
    expect(s.isExcluded("f.ts", 2)).toBe(true);
  });

  it("clears the file's entry when every hunk was applied", () => {
    const s = useResolutionSelection();
    s.toggle("f.ts", 1, "old");
    s.remapAfterApply("f.ts", [0, 1, 2], "new");
    expect(s.excludedCount("f.ts")).toBe(0);
  });
});

describe("useResolutionSelection — failing closed on unexpected content change", () => {
  beforeEach(() => useResolutionSelection().resetAll());

  it("drops the selection when the content stamp no longer matches", () => {
    const s = useResolutionSelection();
    s.toggle("f.ts", 1, contentStamp("original content"));
    // The file changed underneath us: an external edit, a manual resolution,
    // a branch switch. Positional indices can no longer be trusted.
    expect(s.isExcluded("f.ts", 1, contentStamp("something else"))).toBe(false);
    expect(s.excludedCount("f.ts")).toBe(0);
  });

  it("keeps the selection when the stamp still matches", () => {
    const s = useResolutionSelection();
    const stamp = contentStamp("original content");
    s.toggle("f.ts", 1, stamp);
    expect(s.isExcluded("f.ts", 1, stamp)).toBe(true);
  });

  it("shouldApply also fails closed, so no caller can bypass the check", () => {
    const s = useResolutionSelection();
    s.toggle("f.ts", 0, contentStamp("a"));
    expect(s.shouldApply("f.ts", 0, res(99), contentStamp("b"))).toBe(true);
  });

  it("contentStamp distinguishes content, and is stable for equal content", () => {
    expect(contentStamp("abc")).toBe(contentStamp("abc"));
    expect(contentStamp("abc")).not.toBe(contentStamp("abd"));
    expect(contentStamp("abc")).not.toBe(contentStamp("abcd"));
    expect(contentStamp("")).toBe(contentStamp(""));
  });
});

describe("useResolutionSelection — resets", () => {
  it("resetFile clears one file, resetAll clears everything", () => {
    const s = useResolutionSelection();
    s.resetAll();
    s.toggle("a.ts", 0, "stamp");
    s.toggle("b.ts", 0, "stamp");
    s.resetFile("a.ts");
    expect(s.isExcluded("a.ts", 0)).toBe(false);
    expect(s.isExcluded("b.ts", 0)).toBe(true);
    s.resetAll();
    expect(s.isExcluded("b.ts", 0)).toBe(false);
  });
});
