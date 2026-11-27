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
  endpointOrigin: (e: string) => {
    try { return new URL(e).origin; } catch { return null; }
  },
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

  it("needs a bound key for a hosted endpoint, none for the local network", () => {
    for (const hosted of ["https://api.groq.com/openai/v1", "https://api.openai.com/v1"]) {
      settings({ aiApiEndpoint: hosted });
      expect(useAIProvider().isAvailable.value, hosted).toBe(false);
    }
    for (const local of ["http://192.168.1.20:8000/v1", "http://10.0.0.5/v1", "http://llm.local:1234/v1", "http://[::1]:8080/v1", "http://172.20.0.2/v1"]) {
      settings({ aiApiEndpoint: local });
      expect(useAIProvider().isAvailable.value, local).toBe(true);
    }
    settings({ aiApiEndpoint: "http://172.40.0.2/v1" });
    expect(useAIProvider().isAvailable.value).toBe(false);
    // A key bound to the hosted endpoint makes it usable.
    settings({ aiApiEndpoint: "https://api.groq.com/openai/v1" });
    keyConfigured = true;
    keyOrigin = "https://api.groq.com";
    expect(useAIProvider().isAvailable.value).toBe(true);
  });

  it("is not usable left on the default Anthropic endpoint without a bound key", () => {
    // The endpoint setting is shared with the claude provider.
    settings({ aiApiEndpoint: "https://api.anthropic.com" });
    expect(useAIProvider().isAvailable.value).toBe(false);
    expect(useAIProvider().toLlmEndpoint()).toBeNull();
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

  it("stays usable, sending no key, while the stored key belongs to another endpoint", async () => {
    settings();
    keyConfigured = true;
    keyOrigin = "https://api.anthropic.com";
    expect(useAIProvider().isAvailable.value).toBe(true);
    expect(useAIProvider().toLlmEndpoint()).not.toBeNull();
    await useAIProvider().rawPrompt("sys", "user");
    expect(aiHttpRequest.mock.calls[0][2]).toBe("none");
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
