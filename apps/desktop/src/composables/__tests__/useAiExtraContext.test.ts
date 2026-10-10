/**
 * useAiExtraContext — the "ctx" button's extra context, and how it reaches
 * the prompt (withExtraContext).
 */

import { describe, it, expect } from "vitest";
import { getAiExtraContext, setAiExtraContext } from "../useAiExtraContext";
import { withExtraContext } from "../aiTemplateDefaults";

describe("extra context store", () => {
  it("is kept per scope and per repo", () => {
    setAiExtraContext("pr-update:1", "/repos/a", "closes #12");
    expect(getAiExtraContext("pr-update:1", "/repos/a")).toBe("closes #12");
    expect(getAiExtraContext("pr-update:2", "/repos/a")).toBe("");
    expect(getAiExtraContext("pr-update:1", "/repos/b")).toBe("");
  });

  it("matches the repo path with or without a trailing slash", () => {
    setAiExtraContext("releaseNotes", "/repos/c/", "skip refactors");
    expect(getAiExtraContext("releaseNotes", "/repos/c")).toBe("skip refactors");
  });

  it("is cleared by blank text", () => {
    setAiExtraContext("pr-create", "/repos/d", "something");
    setAiExtraContext("pr-create", "/repos/d", "   ");
    expect(getAiExtraContext("pr-create", "/repos/d")).toBe("");
  });
});

describe("withExtraContext", () => {
  it("leaves the prompt unchanged without context", () => {
    expect(withExtraContext("Write the PR description.", undefined)).toBe("Write the PR description.");
    expect(withExtraContext("Write the PR description.", "  \n ")).toBe("Write the PR description.");
  });

  it("appends the trimmed context in a delimited block", () => {
    const out = withExtraContext("Write the PR description.", "  closes #12\n");
    expect(out.startsWith("Write the PR description.\n\n")).toBe(true);
    expect(out).toContain("--- additional context from the user ---\ncloses #12\n--- end additional context ---");
  });
});
