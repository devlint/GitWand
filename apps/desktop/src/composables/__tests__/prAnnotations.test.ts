import { describe, it, expect } from "vitest";
import { fromCIAnnotation, annotationsByLine, worstSeverity, type LineAnnotation } from "../prAnnotations";
import type { CIAnnotation } from "../../utils/backend";

function ciAnn(overrides: Partial<CIAnnotation> = {}): CIAnnotation {
  return {
    checkName: "lint",
    path: "a.ts",
    startLine: 3,
    endLine: 3,
    level: "warning",
    title: "unused var",
    message: "",
    ...overrides,
  };
}

function ann(overrides: Partial<LineAnnotation>): LineAnnotation {
  return {
    source: "ai",
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    severity: "suggestion",
    title: "t",
    ...overrides,
  };
}

describe("fromCIAnnotation", () => {
  it("maps a CIAnnotation onto the shared LineAnnotation model", () => {
    const a = ciAnn({ startLine: 5, endLine: 7, level: "failure", title: "boom", message: "m", checkName: "ci-job" });
    expect(fromCIAnnotation(a)).toEqual({
      source: "ci",
      path: "a.ts",
      line: 5,
      side: "RIGHT",
      endLine: 7,
      severity: "failure",
      title: "boom",
      message: "m",
      checkName: "ci-job",
    });
  });
});

describe("annotationsByLine", () => {
  it("keys by side + line so LEFT and RIGHT don't merge on the same number", () => {
    const map = annotationsByLine([
      ann({ side: "RIGHT", line: 10, title: "right" }),
      ann({ side: "LEFT", line: 10, title: "left" }),
    ]);
    expect(map.get("RIGHT:10")?.map((a) => a.title)).toEqual(["right"]);
    expect(map.get("LEFT:10")?.map((a) => a.title)).toEqual(["left"]);
  });

  it("expands a range annotation line-by-line", () => {
    const map = annotationsByLine([ann({ line: 5, endLine: 7 })]);
    expect(map.has("RIGHT:5")).toBe(true);
    expect(map.has("RIGHT:6")).toBe(true);
    expect(map.has("RIGHT:7")).toBe(true);
    expect(map.has("RIGHT:8")).toBe(false);
  });

  it("caps a huge range at 20 lines by default", () => {
    const map = annotationsByLine([ann({ line: 1, endLine: 1000 })]);
    expect(map.has("RIGHT:20")).toBe(true);
    expect(map.has("RIGHT:21")).toBe(false);
  });

  it("respects a custom cap", () => {
    const map = annotationsByLine([ann({ line: 1, endLine: 1000 })], 5);
    expect(map.has("RIGHT:5")).toBe(true);
    expect(map.has("RIGHT:6")).toBe(false);
  });
});

describe("worstSeverity", () => {
  it("failure/risk outranks warning/suggestion which outranks notice/nit", () => {
    expect(worstSeverity([ann({ severity: "notice" }), ann({ severity: "failure" }), ann({ severity: "warning" })])).toBe("failure");
    expect(worstSeverity([ann({ severity: "nit" }), ann({ severity: "risk" })])).toBe("risk");
    expect(worstSeverity([ann({ severity: "notice" }), ann({ severity: "suggestion" })])).toBe("suggestion");
  });

  it("returns 'notice' for an empty list", () => {
    expect(worstSeverity([])).toBe("notice");
  });

  it("falls back to the first annotation's severity when none are recognized", () => {
    expect(worstSeverity([ann({ severity: "mystery" })])).toBe("mystery");
  });
});
