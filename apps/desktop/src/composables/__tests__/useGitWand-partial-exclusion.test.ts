/**
 * v3.11.0 — a filtered apply must leave the hunks the user held back alone.
 *
 * The trap this file exists for: `resolveAll` and `resolveFile` short-circuit
 * on `result.mergedContent`, which the engine produced by applying *every*
 * resolution. Taking that shortcut while a filter is active silently applies
 * the excluded hunks and the whole opt-out feature becomes decorative. The
 * shortcut is therefore only legal when there is no filter, which is what
 * `buildResolvedContent` encodes and what the first block below pins.
 *
 * The second trap is subtler: partial application must leave the surviving
 * conflict block *byte-identical*, diff3 base section included. Re-emitting a
 * hunk from parsed pieces instead of preserving the original text loses the
 * base, and with it every diff3-only pattern on the next pass.
 */

import { describe, it, expect } from "vitest";
import { buildResolvedContent, buildPartialContent } from "../useGitWand";

/** A minimal stand-in for a core `HunkResolution`. */
const r = (applied: boolean, lines: string[] | null = ["RESOLVED"]) => ({
  autoResolved: applied,
  resolvedLines: applied ? lines : null,
  hunk: { confidence: { score: 100 } },
  resolutionReason: "",
}) as never;

const THREE_HUNKS = [
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
  "between",
  "<<<<<<< ours",
  "ours-2",
  "||||||| base",
  "base-2",
  "=======",
  "theirs-2",
  ">>>>>>> theirs",
  "footer",
].join("\n");

describe("buildResolvedContent — the mergedContent fast path", () => {
  const result = {
    mergedContent: "FULLY MERGED BY THE ENGINE",
    resolutions: [r(true), r(true), r(true)],
  };

  it("uses mergedContent when no filter is active", () => {
    expect(buildResolvedContent(THREE_HUNKS, result as never)).toBe(
      "FULLY MERGED BY THE ENGINE",
    );
  });

  it("BYPASSES mergedContent as soon as a predicate is supplied", () => {
    // mergedContent already contains every resolution, so taking it here would
    // apply the hunk the predicate is refusing. This is the regression.
    const out = buildResolvedContent(THREE_HUNKS, result as never, (i) => i !== 1);
    expect(out).not.toBe("FULLY MERGED BY THE ENGINE");
    expect(out).toContain("RESOLVED");
    expect(out, "the excluded hunk keeps its markers").toContain("<<<<<<< ours");
  });

  it("bypasses it even when the predicate happens to accept everything", () => {
    // The decision is "is a filter active", not "did the filter reject
    // anything": a predicate that accepts all today may reject tomorrow, and
    // the two paths must not produce different content for the same input.
    const out = buildResolvedContent(THREE_HUNKS, result as never, () => true);
    expect(out).not.toBe("FULLY MERGED BY THE ENGINE");
    expect(out).not.toContain("<<<<<<<");
  });
});

describe("buildPartialContent — exclusion", () => {
  it("applies every auto-resolved hunk when no predicate is given", () => {
    const out = buildPartialContent(THREE_HUNKS, [r(true), r(true), r(true)] as never);
    expect(out).not.toContain("<<<<<<<");
    expect(out.match(/RESOLVED/g)?.length).toBe(3);
  });

  it("applies 0 and 2 while hunk 1 survives untouched", () => {
    const out = buildPartialContent(
      THREE_HUNKS,
      [r(true), r(true), r(true)] as never,
      (i) => i !== 1,
    );

    expect(out.match(/RESOLVED/g)?.length, "two hunks applied").toBe(2);
    // The survivor must come back byte for byte, diff3 base included: losing
    // the base section would disable every diff3-only pattern next pass.
    expect(out).toContain(
      ["<<<<<<< ours", "ours-1", "||||||| base", "base-1", "=======", "theirs-1", ">>>>>>> theirs"].join("\n"),
    );
    expect(out).not.toContain("ours-0");
    expect(out).not.toContain("ours-2");
    // Surrounding context is preserved verbatim.
    expect(out.startsWith("header")).toBe(true);
    expect(out.endsWith("footer")).toBe(true);
    expect(out).toContain("middle");
    expect(out).toContain("between");
  });

  it("never applies a hunk the engine declined, whatever the predicate says", () => {
    const out = buildPartialContent(
      THREE_HUNKS,
      [r(true), r(false), r(true)] as never,
      () => true,
    );
    expect(out).toContain("ours-1");
    expect(out.match(/RESOLVED/g)?.length).toBe(2);
  });

  it("excluding everything is an exact no-op on the original text", () => {
    const out = buildPartialContent(
      THREE_HUNKS,
      [r(true), r(true), r(true)] as never,
      () => false,
    );
    expect(out).toBe(THREE_HUNKS);
  });

  it("passes the resolution to the predicate, not just the index", () => {
    const seen: number[] = [];
    buildPartialContent(
      THREE_HUNKS,
      [r(true), r(true), r(true)] as never,
      (i, res) => {
        expect(res.resolvedLines).toEqual(["RESOLVED"]);
        seen.push(i);
        return true;
      },
    );
    expect(seen).toEqual([0, 1, 2]);
  });

  it("handles a 2-way (no base) conflict block", () => {
    const twoWay = [
      "<<<<<<< ours",
      "ours-only",
      "=======",
      "theirs-only",
      ">>>>>>> theirs",
    ].join("\n");
    expect(buildPartialContent(twoWay, [r(true)] as never, () => false)).toBe(twoWay);
    expect(buildPartialContent(twoWay, [r(true)] as never, () => true)).toBe("RESOLVED");
  });
});
