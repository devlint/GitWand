/**
 * Task 3 (v3.7.0) — `buildReviewFixPrompt`: the plain-text instruction block
 * typed into an agent's PTY after "Fix with agent" (never auto-submitted —
 * plan decision D7). Pure, no mocks.
 */
import { describe, it, expect } from "vitest";
import { buildReviewFixPrompt } from "../reviewFixPrompt";
import type { ReviewFinding } from "../../composables/usePrPreReview";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    path: "src/a.ts",
    line: 1,
    side: "RIGHT",
    severity: "nit",
    confidence: 50,
    title: "A nit",
    detail: "A nit detail",
    ...overrides,
  };
}

describe("buildReviewFixPrompt", () => {
  it("returns an empty string for zero findings", () => {
    expect(buildReviewFixPrompt([])).toBe("");
  });

  it("orders entries severity-first (risk > suggestion > nit), then confidence descending", () => {
    const findings = [
      finding({ id: "nit-1", severity: "nit", confidence: 90, title: "Nit" }),
      finding({ id: "risk-1", severity: "risk", confidence: 60, title: "Risk" }),
      finding({ id: "suggestion-1", severity: "suggestion", confidence: 80, title: "Suggestion" }),
    ];
    const prompt = buildReviewFixPrompt(findings);
    const riskIdx = prompt.indexOf("Risk");
    const suggestionIdx = prompt.indexOf("Suggestion");
    const nitIdx = prompt.indexOf("Nit");
    expect(riskIdx).toBeGreaterThan(-1);
    expect(riskIdx).toBeLessThan(suggestionIdx);
    expect(suggestionIdx).toBeLessThan(nitIdx);
  });

  it("includes path:line for every finding", () => {
    const findings = [
      finding({ path: "src/a.ts", line: 12 }),
      finding({ id: "f2", path: "src/b.ts", line: 34 }),
    ];
    const prompt = buildReviewFixPrompt(findings);
    expect(prompt).toContain("src/a.ts:12");
    expect(prompt).toContain("src/b.ts:34");
  });

  it("caps at maxFindings (default 25) and appends an 'and N more' tail", () => {
    const findings = Array.from({ length: 30 }, (_, i) =>
      finding({ id: `f${i}`, path: `src/f${i}.ts`, line: i, title: `Finding ${i}` }),
    );
    const prompt = buildReviewFixPrompt(findings);
    const shownCount = (prompt.match(/^- /gm) ?? []).length;
    expect(shownCount).toBe(25);
    expect(prompt).toContain("and 5 more");
  });

  it("respects a custom maxFindings option", () => {
    const findings = Array.from({ length: 4 }, (_, i) => finding({ id: `f${i}`, path: `src/f${i}.ts` }));
    const prompt = buildReviewFixPrompt(findings, { maxFindings: 2 });
    const shownCount = (prompt.match(/^- /gm) ?? []).length;
    expect(shownCount).toBe(2);
    expect(prompt).toContain("and 2 more");
  });

  it("collapses interior newlines in detail to spaces and strips \\r", () => {
    const findings = [finding({ detail: "Line one\r\nLine two\nLine three" })];
    const prompt = buildReviewFixPrompt(findings);
    expect(prompt).not.toContain("\r");
    expect(prompt).toContain("Line one Line two Line three");
  });

  it("ends with exactly one trailing newline", () => {
    const prompt = buildReviewFixPrompt([finding()]);
    expect(prompt.endsWith("\n")).toBe(true);
    expect(prompt.endsWith("\n\n")).toBe(false);
  });

  it("never includes an em dash between title and detail (house style: hyphen only)", () => {
    const prompt = buildReviewFixPrompt([finding({ title: "T", detail: "D" })]);
    expect(prompt).not.toContain("—");
  });
});
