/**
 * `explanationRef` — the translatable form of a hunk's `explanation`. Each
 * hunk names its English text as a key (and parameters) that an app can show
 * in the user's language; the key must follow the same branch as the text.
 */
import { describe, expect, it } from "vitest";
import { classifyConflict } from "../classifier.js";
import { resolve, resolveAsync, EXPLANATION_PARAMS } from "../index.js";
import { runLlmFallbackPhase } from "../resolver/llm-pipeline.js";
import { withoutFormatResolver } from "../resolver/retract.js";
import type { ClassifyInput, ConflictHunk, PatternPlugin } from "../types.js";
import p0 from "../patterns/same-change.js";
import p1 from "../patterns/delete-no-change.js";
import p2 from "../patterns/one-side-change.js";
import p3 from "../patterns/non-overlapping.js";
import p4 from "../patterns/whitespace-only.js";
import p5 from "../patterns/reorder-only.js";
import p6 from "../patterns/insertion-at-boundary.js";
import p7 from "../patterns/value-only-change.js";
import p8 from "../patterns/token-level-merge.js";
import p9 from "../patterns/llm-proposed.js";
import p10 from "../patterns/refactoring-aware-merge.js";
import p11 from "../patterns/complex.js";

const PLUGINS: PatternPlugin[] = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11];

const input = (ours: string[], base: string[], theirs: string[]): ClassifyInput => ({
  oursLines: ours,
  baseLines: base,
  theirsLines: theirs,
  startLine: 1,
  endLine: 1,
});

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  ["<<<<<<< ours", ...ours, "||||||| base", ...base, "=======", ...theirs, ">>>>>>> theirs"].join("\n");

/** The ref is valid: a known key with as many parameters as it takes. */
function expectValid(ref: ConflictHunk["explanationRef"]) {
  expect(ref).toBeDefined();
  expect(Object.keys(EXPLANATION_PARAMS)).toContain(ref!.key);
  expect(ref!.params?.length ?? 0).toBe(EXPLANATION_PARAMS[ref!.key]);
}

describe("explanationRef", () => {
  it("is given by every built-in pattern", () => {
    for (const p of PLUGINS) expect(typeof p.explanationRef, p.type).toBe("function");
  });

  const cases: Array<[string, ClassifyInput, string, Array<string | number>?]> = [
    ["same change", input(["a2"], ["a"], ["a2"]), "sameChange"],
    ["theirs only", input(["a"], ["a"], ["a2"]), "oneSideTheirs"],
    ["ours only", input(["a2"], ["a"], ["a"]), "oneSideOurs"],
    ["ours deleted", input([], ["a"], ["a"]), "deleteOurs"],
    ["theirs deleted", input(["a"], ["a"], []), "deleteTheirs"],
    ["whitespace only", input(["  x = 1;"], ["y"], ["x = 1;"]), "whitespaceOnly"],
    ["insertions", input(["a", "b"], ["a"], ["a", "c"]), "insertion"],
    ["complex", input(["function f() { return 1; }"], ["function f() { return 0; }"], ["const g = () => 2;"]), "complex"],
  ];

  for (const [name, hunk, key] of cases) {
    it(`names the ${name} explanation (${key})`, () => {
      const result = classifyConflict(hunk);
      expectValid(result.explanationRef);
      expect(result.explanationRef!.key).toBe(key);
    });
  }

  it("carries the count of a value-only change", () => {
    const result = classifyConflict(input(['  "version": "1.2.4"'], ['  "version": "1.2.3"'], ['  "version": "1.2.5"']));
    expect(result.type).toBe("value_only_change");
    expect(result.explanationRef).toEqual({ key: "valueOnly", params: [1] });
  });

  it("is set on every hunk the parser builds, and matches the hunk's type", () => {
    const content = [
      conflict(["a2"], ["a"], ["a2"]),
      "mid",
      conflict(["b"], ["b"], ["b2"]),
    ].join("\n");
    const result = resolve(content, "notes.txt");
    for (const hunk of result.hunks) expectValid(hunk.explanationRef);
    expect(result.hunks.map((h) => h.explanationRef!.key)).toEqual(["sameChange", "oneSideTheirs"]);
  });

  it("names the format resolver of a semantic merge", () => {
    const content = conflict(
      ["{", '  "name": "app",', '  "alpha": 1', "}"],
      ["{", '  "name": "app"', "}"],
      ["{", '  "name": "app",', '  "beta": 2', "}"],
    );
    const hunk = resolve(content, "config.json").hunks[0];
    expect(hunk.type).toBe("format_semantic");
    expect(hunk.explanationRef?.key).toBe("formatSemantic");
    expect(hunk.explanationRef?.params?.[0]).toBe(hunk.formatResolver);
    expectValid(hunk.explanationRef);
  });

  it("follows a reclassification to a generated file", () => {
    const content = [
      "{",
      conflict(['  "pkg-a": "1.0.1",'], ['  "pkg-a": "1.0.0",'], ['  "pkg-b": "2.0.0",']),
      "}",
    ].join("\n");
    const hunk = resolve(content, "package-lock.json").hunks[0];
    expect(hunk.type).toBe("generated_file");
    expect(hunk.explanationRef).toEqual({ key: "generatedFile", params: ["npm lockfile"] });
  });

  it("recomputes the value-only count when a line array of the same input changes", () => {
    const h = input(['  "version": "1.2.4"'], ['  "version": "1.2.3"'], ['  "version": "1.2.5"']);
    expect(p7.explanationRef!(h)).toEqual({ key: "valueOnly", params: [1] });
    // Edited in place, same arrays.
    h.oursLines[0] = '  "version": "1.2.4", "build": "a1"';
    h.theirsLines[0] = '  "version": "1.2.5", "build": "b2"';
    const after = p7.explanationRef!(h);
    expect(after).not.toEqual({ key: "valueOnly", params: [1] });
  });

  it("gives an unsent llm_proposed hunk the genuine-conflict explanation", async () => {
    const result = resolve(conflict(["x = 1"], ["x = 0"], ["x = 2"]), "a.txt");
    const llmHunk = { ...result.hunks[0], type: "llm_proposed" as const, explanationRef: { key: "llmProposed" as const } };
    const faked = { ...result, hunks: [llmHunk], resolutions: [{ ...result.resolutions[0], hunk: llmHunk, autoResolved: false }] };
    const out = await runLlmFallbackPhase("", faked, "a.txt", { llmFallback: { enabled: false } } as never);
    expect(out.hunks[0].explanationRef).toEqual({ key: "complex" });
    expect(out.resolutions[0].hunk.explanationRef).toEqual({ key: "complex" });
  });

  it("does not say a refused format merge was resolved by its resolver", () => {
    const content = conflict(
      ["{", '  "name": "app",', '  "alpha": 1', "}"],
      ["{", '  "name": "app"', "}"],
      ["{", '  "name": "app",', '  "beta": 2', "}"],
    );
    const result = resolve(content, "config.json", { policy: "strict" });
    expect(result.resolutions[0].autoResolved).toBe(false);
    for (const h of [result.hunks[0], result.resolutions[0].hunk]) {
      expect(h.explanationRef?.key).not.toBe("formatSemantic");
      expect(h.explanation).not.toContain("resolved semantically");
    }
  });

  it("puts a withdrawn LLM or format resolution back to the genuine-conflict explanation", () => {
    const base = resolve(conflict(["x = 1"], ["x = 0"], ["x = 2"]), "a.txt").hunks[0];
    for (const key of ["llmProposed", "formatSemantic", "structuralMerge"] as const) {
      const h = withoutFormatResolver({ ...base, explanation: "claimed", explanationRef: { key, ...(key === "formatSemantic" ? { params: ["json"] } : {}) } });
      expect(h.explanationRef).toEqual({ key: "complex" });
      expect(h.explanation).not.toBe("claimed");
    }
    // Any other explanation is kept.
    const kept = withoutFormatResolver({ ...base, explanationRef: { key: "oneSideOurs" } });
    expect(kept.explanationRef).toEqual({ key: "oneSideOurs" });
  });

  it("calls a format merge a format merge, not an LLM proposal, with the LLM fallback on", async () => {
    const content = conflict(
      ["{", '  "name": "app",', '  "alpha": 1', "}"],
      ["{", '  "name": "app"', "}"],
      ["{", '  "name": "app",', '  "beta": 2', "}"],
    );
    let calls = 0;
    const endpoint = { async call() { calls++; return "CANNOT_RESOLVE"; } };
    const result = await resolveAsync(content, "config.json", { llmFallback: { enabled: true, endpoint }, validationLevel: "off" });
    expect(result.resolutions[0].autoResolved).toBe(true);
    expect(result.hunks[0].type).toBe("format_semantic");
    expect(result.hunks[0].explanationRef?.key).toBe("formatSemantic");
    expect(calls).toBe(0);
  });
});
