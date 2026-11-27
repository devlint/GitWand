// @vitest-environment jsdom
/**
 * An OpenAI-compatible server without a key (llama.cpp, vLLM, LM Studio):
 * the provider is available with an endpoint alone, and its requests go out
 * with `auth: "none"`. With a stored key they carry it (`bearer`). Before,
 * the model list loaded but completions required a key and always sent
 * `bearer`, so such a server was never usable. A key stored for another
 * origin is not sent (the backend would refuse the whole request).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const aiHttpRequest = vi.fn();
let keyConfigured = false;
/** Origin the stored key is bound to, when one is stored. */
let keyOrigin: string | null = null;

vi.mock("../../utils/backend", async () => {
  const actual = await vi.importActual<typeof import("../../utils/backend")>("../../utils/backend");
  return { ...actual, aiHttpRequest: (...a: unknown[]) => aiHttpRequest(...a) };
});
vi.mock("../useAiApiKey", () => ({
  ensureAiApiKeyLoaded: vi.fn(async () => {}),
  isAiApiKeyConfigured: () => keyConfigured,
  aiApiKeyBoundTo: (endpoint: string) => keyConfigured && keyOrigin === new URL(endpoint).origin,
  aiApiKeyOrigin: () => (keyConfigured ? keyOrigin : null),
}));

import { useAIProvider, fetchOpenAICompatModels } from "../useAIProvider";

function settings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    "gitwand-settings",
    JSON.stringify({
      aiEnabled: true,
      aiProvider: "openai-compat",
      aiApiEndpoint: "http://localhost:8080/v1",
      aiModel: "local-model",
      ...extra,
    }),
  );
}

describe("OpenAI-compatible provider without a key", () => {
  beforeEach(() => {
    localStorage.clear();
    keyConfigured = false;
    keyOrigin = null;
    aiHttpRequest.mockReset().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "ok" } }], data: [{ id: "m" }] }),
    });
  });

  it("is available with an endpoint alone", () => {
    settings();
    expect(useAIProvider().isAvailable.value).toBe(true);
  });

  it("is not available without an endpoint", () => {
    settings({ aiApiEndpoint: "" });
    // No key, no endpoint, no Claude CLI detected: nothing to use.
    expect(useAIProvider().isAvailable.value).toBe(false);
  });

  it("sends a completion with auth none, and with bearer once a key is stored", async () => {
    settings();
    expect(await useAIProvider().rawPrompt("sys", "user")).toBe("ok");
    expect(aiHttpRequest.mock.calls[0].slice(0, 3)).toEqual([
      "POST",
      "http://localhost:8080/v1/chat/completions",
      "none",
    ]);

    keyConfigured = true;
    keyOrigin = "http://localhost:8080";
    await useAIProvider().rawPrompt("sys", "user");
    expect(aiHttpRequest.mock.calls[1][2]).toBe("bearer");
  });

  it("is not available while the stored key belongs to another endpoint (stale setup)", () => {
    settings();
    keyConfigured = true;
    keyOrigin = "https://api.anthropic.com";
    // No Claude CLI detected here, so nothing to fall back to either.
    expect(useAIProvider().isAvailable.value).toBe(false);
    expect(useAIProvider().toLlmEndpoint()).toBeNull();
  });

  it("says the stored key is tied to another endpoint when the server refuses", async () => {
    settings();
    keyConfigured = true;
    keyOrigin = "https://api.groq.com";
    aiHttpRequest.mockResolvedValueOnce({ status: 401, body: "unauthorized" });
    await expect(useAIProvider().rawPrompt("sys", "user")).rejects.toThrow(/api\.groq\.com/);
  });

  it("says a key stored before the binding must be entered again when the server refuses", async () => {
    settings();
    keyConfigured = true;
    keyOrigin = null;
    aiHttpRequest.mockResolvedValueOnce({ status: 401, body: "unauthorized" });
    await expect(useAIProvider().rawPrompt("sys", "user")).rejects.toThrow(/stored before keys were tied/);
  });

  it("offers the core an LLM endpoint without a key", () => {
    settings();
    expect(useAIProvider().toLlmEndpoint()).not.toBeNull();
  });

  it("lists models with the same auth", async () => {
    await fetchOpenAICompatModels("http://localhost:8080/v1");
    expect(aiHttpRequest.mock.calls[0][2]).toBe("none");
  });
});
