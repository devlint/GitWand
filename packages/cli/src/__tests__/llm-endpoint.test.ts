/**
 * Tests unitaires pour `buildLlmEndpoint()`.
 *
 * On mock le `fetch` global (Node 20+) via `vi.stubGlobal` et on vérifie pour
 * chaque provider :
 *  - URL ciblée, headers, body envoyés,
 *  - parsing de la réponse spécifique au provider,
 *  - propagation d'erreur claire en cas d'HTTP non-2xx,
 *  - throw explicite si la clé API requise manque.
 *
 * Aucun appel réseau réel — `vi.fn()` retourne des `Response` synthétiques.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLlmEndpoint } from "../llm-endpoint.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getFetchCall(fetchMock: FetchMock): { url: string; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const args = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: args[0], init: args[1] };
}

describe("buildLlmEndpoint — Claude", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ANTHROPIC_API_KEY = "sk-test-claude";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("posts to the messages endpoint with the correct headers and body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: "text", text: "resolved code" }] }),
    );

    const endpoint = buildLlmEndpoint({
      provider: "claude",
      model: "claude-sonnet-4-6",
      maxTokens: 1234,
      temperature: 0.1,
    });

    const out = await endpoint.call("hello prompt");

    expect(out).toBe("resolved code");
    const { url, init } = getFetchCall(fetchMock);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test-claude");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1234,
      temperature: 0.1,
      messages: [{ role: "user", content: "hello prompt" }],
    });
  });

  it("throws a clear error when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const endpoint = buildLlmEndpoint({ provider: "claude", model: "claude-sonnet-4-6" });
    await expect(endpoint.call("prompt")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the response shape is unexpected", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [] }));
    const endpoint = buildLlmEndpoint({ provider: "claude", model: "claude-sonnet-4-6" });
    await expect(endpoint.call("prompt")).rejects.toThrow(/content\[0\]\.text/);
  });

  it("surfaces HTTP errors with status and truncated body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("server overloaded", { status: 503 }),
    );
    const endpoint = buildLlmEndpoint({ provider: "claude", model: "claude-sonnet-4-6" });
    await expect(endpoint.call("prompt")).rejects.toThrow(/HTTP 503/);
  });
});

describe("buildLlmEndpoint — OpenAI", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "sk-test-openai";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("posts to the chat completions endpoint with bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    const endpoint = buildLlmEndpoint({
      provider: "openai",
      model: "gpt-4o-mini",
      maxTokens: 500,
      temperature: 0,
    });

    const out = await endpoint.call("prompt-x");

    expect(out).toBe("ok");
    const { url, init } = getFetchCall(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-openai");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gpt-4o-mini",
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: "user", content: "prompt-x" }],
    });
  });

  it("throws when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const endpoint = buildLlmEndpoint({ provider: "openai", model: "gpt-4o-mini" });
    await expect(endpoint.call("p")).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the response shape is unexpected", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    const endpoint = buildLlmEndpoint({ provider: "openai", model: "gpt-4o-mini" });
    await expect(endpoint.call("p")).rejects.toThrow(/choices\[0\]\.message\.content/);
  });
});

describe("buildLlmEndpoint — Ollama", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OLLAMA_URL;
  });

  it("posts to the local /api/chat endpoint with no auth header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: "assistant", content: "local output" } }),
    );

    const endpoint = buildLlmEndpoint({
      provider: "ollama",
      model: "llama3",
      maxTokens: 256,
      temperature: 0.2,
    });

    const out = await endpoint.call("prompt-ollama");

    expect(out).toBe("local output");
    const { url, init } = getFetchCall(fetchMock);
    expect(url).toBe("http://localhost:11434/api/chat");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "llama3",
      messages: [{ role: "user", content: "prompt-ollama" }],
      options: { temperature: 0.2, num_predict: 256 },
      stream: false,
    });
  });

  it("respects baseUrl override and strips trailing slashes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "remote" } }),
    );

    const endpoint = buildLlmEndpoint({
      provider: "ollama",
      model: "llama3",
      baseUrl: "https://ollama.example.com//",
    });

    await endpoint.call("p");
    const { url } = getFetchCall(fetchMock);
    expect(url).toBe("https://ollama.example.com/api/chat");
  });

  it("falls back to OLLAMA_URL env when baseUrl not provided", async () => {
    process.env.OLLAMA_URL = "http://10.0.0.1:11434";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "env-routed" } }),
    );

    const endpoint = buildLlmEndpoint({ provider: "ollama", model: "llama3" });
    await endpoint.call("p");
    const { url } = getFetchCall(fetchMock);
    expect(url).toBe("http://10.0.0.1:11434/api/chat");
  });

  it("throws when the response shape is unexpected", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ something: "else" }));
    const endpoint = buildLlmEndpoint({ provider: "ollama", model: "llama3" });
    await expect(endpoint.call("p")).rejects.toThrow(/message\.content/);
  });
});

describe("buildLlmEndpoint — error envelope", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("wraps fetch network errors with the target URL", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const endpoint = buildLlmEndpoint({ provider: "claude", model: "claude-sonnet-4-6" });
    await expect(endpoint.call("p")).rejects.toThrow(/api\.anthropic\.com.*ECONNREFUSED/);
  });

  it("reports JSON parse failures with the response snippet", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const endpoint = buildLlmEndpoint({ provider: "claude", model: "claude-sonnet-4-6" });
    await expect(endpoint.call("p")).rejects.toThrow(/parse claude response as JSON/);
  });
});
