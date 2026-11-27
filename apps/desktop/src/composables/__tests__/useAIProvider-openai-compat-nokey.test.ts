// @vitest-environment jsdom
/**
 * An OpenAI-compatible server without a key (llama.cpp, vLLM, LM Studio):
 * the provider is available with an endpoint alone, and its requests go out
 * with `auth: "none"`. With a stored key they carry it (`bearer`). Before,
 * the model list loaded but completions required a key and always sent
 * `bearer`, so such a server was never usable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const aiHttpRequest = vi.fn();
let keyConfigured = false;

vi.mock("../../utils/backend", async () => {
  const actual = await vi.importActual<typeof import("../../utils/backend")>("../../utils/backend");
  return { ...actual, aiHttpRequest: (...a: unknown[]) => aiHttpRequest(...a) };
});
vi.mock("../useAiApiKey", () => ({
  ensureAiApiKeyLoaded: vi.fn(async () => {}),
  isAiApiKeyConfigured: () => keyConfigured,
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
    await useAIProvider().rawPrompt("sys", "user");
    expect(aiHttpRequest.mock.calls[1][2]).toBe("bearer");
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
