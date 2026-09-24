import { describe, it, expect } from "vitest";
import { mergeLlmFallbackForSave } from "../llmFallbackRc";

describe("mergeLlmFallbackForSave", () => {
  const edited = {
    enabled: true,
    provider: "ollama",
    minPostMergeScore: 90,
    contextLines: 30,
    minMode: "balanced",
  };

  it("keeps keys the settings UI does not edit (history opt-out, model)", () => {
    const existing = {
      enabled: false,
      provider: "claude",
      model: "claude-sonnet",
      maxTokens: 2048,
      temperature: 0.2,
      history: { enabled: false, budgetTokens: 900 },
    };
    expect(mergeLlmFallbackForSave(existing, edited)).toEqual({
      ...edited,
      model: "claude-sonnet",
      maxTokens: 2048,
      temperature: 0.2,
      history: { enabled: false, budgetTokens: 900 },
    });
  });

  it("lets the edited fields win over the existing ones", () => {
    const out = mergeLlmFallbackForSave({ enabled: false, provider: "claude" }, edited);
    expect(out.enabled).toBe(true);
    expect(out.provider).toBe("ollama");
  });

  it("accepts a missing or non-object existing block", () => {
    expect(mergeLlmFallbackForSave(undefined, edited)).toEqual(edited);
    expect(mergeLlmFallbackForSave("nope", edited)).toEqual(edited);
  });

  it("never persists an endpoint", () => {
    const out = mergeLlmFallbackForSave({ endpoint: "x" }, edited);
    expect(out).not.toHaveProperty("endpoint");
  });
});
