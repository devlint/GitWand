/**
 * #301 — A resolution retracted for a format invariant names no format
 * resolver: the hunk was not resolved by it in the end.
 */
import { describe, it, expect } from "vitest";
import { retractForInvariant } from "../resolver/index.js";
import type { ConflictHunk, HunkResolution } from "../types.js";

const hunk = { type: "format_semantic", formatResolver: "json" } as unknown as ConflictHunk;

describe("retractForInvariant", () => {
  it("drops the resolution and the resolver's name from hunks and resolutions", () => {
    const res: HunkResolution = { hunk, resolvedLines: ["{}"], autoResolved: true, resolutionReason: "r" };
    const out = retractForInvariant([hunk], [res], "duplicate key");
    expect(out.hunks[0].formatResolver).toBeUndefined();
    expect(out.resolutions[0].hunk.formatResolver).toBeUndefined();
    expect(out.resolutions[0].resolvedLines).toBeNull();
    expect(out.resolutions[0].autoResolved).toBe(false);
    expect(out.resolutions[0].resolutionReason).toContain("duplicate key");
  });

  it("leaves an unresolved hunk as it was", () => {
    const res: HunkResolution = { hunk, resolvedLines: null, autoResolved: false, resolutionReason: "manual" };
    expect(retractForInvariant([hunk], [res], "x").resolutions[0]).toBe(res);
  });
});
