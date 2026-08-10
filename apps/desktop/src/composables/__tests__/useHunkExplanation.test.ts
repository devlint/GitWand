/**
 * Issue #133 (sub-issue 4) — per-hunk AI explanation text occasionally
 * comes back in the wrong language. The locale is correctly threaded
 * end-to-end (system prompt already carries "Write in ${lang}…"), but a
 * language instruction buried only in the system prompt can drift with some
 * providers. Mitigation: repeat a short, explicit language directive at the
 * very end of the user-facing prompt as well — end-of-prompt instructions
 * tend to be followed more reliably.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: isAvailableRef,
    rawPrompt: (...a: unknown[]) => rawPromptMock(...a),
  }),
}));

import { useHunkExplanation, buildUserPrompt } from "../useHunkExplanation";
import type { ConflictHunk } from "@gitwand/core";

function hunk(): ConflictHunk {
  return {
    baseLines: ["base"],
    oursLines: ["ours"],
    theirsLines: ["theirs"],
    startLine: 1,
    type: "complex",
    confidence: {
      score: 20,
      label: "low",
      dimensions: { typeClassification: 20, dataRisk: 80, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 },
      boosters: [],
      penalties: [],
    },
    explanation: "test",
    trace: { steps: [{ type: "same_change", passed: false, reason: "diverging" }], selected: "complex", summary: "test", hasBase: true },
  } as unknown as ConflictHunk;
}

describe("buildUserPrompt", () => {
  it("ends with an explicit language directive", () => {
    const prompt = buildUserPrompt(hunk(), "src/foo.ts", 1500, "French");
    expect(prompt.trim().endsWith("(Respond only in French.)")).toBe(true);
  });

  it("still contains the decision trace and file path ahead of the directive", () => {
    const prompt = buildUserPrompt(hunk(), "src/foo.ts", 1500, "English");
    expect(prompt).toContain("File: src/foo.ts");
    expect(prompt).toContain("[rejected] same_change: diverging");
    expect(prompt.indexOf("Explain this conflict.")).toBeLessThan(
      prompt.indexOf("(Respond only in English.)"),
    );
  });
});

describe("useHunkExplanation.explain", () => {
  beforeEach(() => {
    rawPromptMock.mockReset();
    isAvailableRef.value = true;
  });

  it("passes a user prompt ending with the language directive for the active locale", async () => {
    rawPromptMock.mockResolvedValue("Explication de test.");
    const { explain } = useHunkExplanation();
    await explain(hunk(), { locale: "fr", filePath: "src/foo.ts" });

    const [systemPrompt, userPrompt] = rawPromptMock.mock.calls[0];
    expect(systemPrompt).toContain("Write in French");
    expect(userPrompt.trim().endsWith("(Respond only in French.)")).toBe(true);
  });

  it("defaults to French when no locale is provided (matches existing default)", async () => {
    rawPromptMock.mockResolvedValue("Explication.");
    const { explain } = useHunkExplanation();
    await explain(hunk());

    const [, userPrompt] = rawPromptMock.mock.calls[0];
    expect(userPrompt.trim().endsWith("(Respond only in French.)")).toBe(true);
  });
});
