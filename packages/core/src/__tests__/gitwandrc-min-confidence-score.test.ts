/**
 * v3.11.0 — `.gitwandrc`'s `minConfidenceScore`.
 *
 * The numeric confidence bar has to be reachable outside the desktop app, or
 * it is a setting only one of the four consumers can use. `.gitwandrc` is the
 * repo-level home for it, alongside `policy` and `resolveGeneratedFiles`.
 *
 * `parseGitwandrc` is deliberately tolerant: a nearly-valid config should lose
 * the field it got wrong, not the whole file. An out-of-range or non-numeric
 * bar is therefore ignored rather than fatal, which also means a typo can only
 * ever leave the bar off, never silently set it somewhere unintended.
 */

import { describe, expect, it } from "vitest";
import { parseGitwandrc } from "../config.js";

const rc = (obj: unknown) => parseGitwandrc(JSON.stringify(obj));

describe("parseGitwandrc — minConfidenceScore", () => {
  it("reads a valid bar", () => {
    expect(rc({ minConfidenceScore: 90 })?.minConfidenceScore).toBe(90);
  });

  it.each([0, 60, 75, 100])("accepts the boundary value %i", (v) => {
    expect(rc({ minConfidenceScore: v })?.minConfidenceScore).toBe(v);
  });

  it.each([
    ["negative", -1],
    ["above 100", 101],
    ["a string", "90"],
    ["a bool", true],
    ["null", null],
    ["NaN-ish", "not a number"],
  ])("ignores %s rather than failing the whole file", (_label, value) => {
    const cfg = rc({ policy: "prefer-merge", minConfidenceScore: value });
    expect(cfg, "the rest of the config still parses").not.toBeNull();
    expect(cfg?.policy).toBe("prefer-merge");
    expect(cfg?.minConfidenceScore).toBeUndefined();
  });

  it("is absent when not configured", () => {
    expect(rc({ policy: "strict" })?.minConfidenceScore).toBeUndefined();
  });

  it("coexists with the other repo-level keys", () => {
    const cfg = rc({
      policy: "prefer-merge",
      resolveGeneratedFiles: true,
      generatedFiles: ["*.lock"],
      minConfidenceScore: 75,
    });
    expect(cfg?.policy).toBe("prefer-merge");
    expect(cfg?.resolveGeneratedFiles).toBe(true);
    expect(cfg?.generatedFiles).toEqual(["*.lock"]);
    expect(cfg?.minConfidenceScore).toBe(75);
  });
});
