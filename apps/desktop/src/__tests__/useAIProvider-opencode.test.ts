/**
 * v2.17 — opencode provider + per-provider model picker.
 *
 * Covers the two pieces the feature introduces in `useAIProvider`:
 *
 *   1. `modelForProvider` / `listModelsForProvider` — the model-selection
 *      helpers backing the Settings second select. CLI agents are model-
 *      scoped via `aiModelByProvider`; opencode enumerates dynamically,
 *      Claude Code advertises curated aliases, the other CLIs enumerate through their own commands.
 *
 *   2. Provider dispatch in `rawPrompt()` — the opencode-cli case must route
 *      to `opencodeCliPrompt`, and all three CLI agents must forward the
 *      per-provider model string to their respective backend wrapper.
 *
 * We mock `../utils/backend` so no Tauri / dev-server call is made and assert
 * on the exact arguments each CLI wrapper receives.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the backend CLI wrappers ─────────────────────────────
// Declared via `vi.hoisted` so the spies exist before the hoisted
// `vi.mock` factory runs — `useAIProvider` calls `detectClaudeCli()` at
// module load, which would otherwise hit a TDZ on plain `const` spies.
const {
  claudeCliPrompt,
  codexCliPrompt,
  opencodeCliPrompt,
  copilotCliPrompt,
  listOpencodeModels,
  listAntigravityModels,
  listCopilotModels,
  listCodexModels,
  detectClaudeCli,
} = vi.hoisted(() => ({
  claudeCliPrompt: vi.fn(async () => "ok-claude"),
  codexCliPrompt: vi.fn(async () => "ok-codex"),
  opencodeCliPrompt: vi.fn(async () => "ok-opencode"),
  copilotCliPrompt: vi.fn(async () => "ok-copilot"),
  listOpencodeModels: vi.fn(async () => ["anthropic/claude-x", "openai/gpt-y"]),
  listCodexModels: vi.fn(async () => [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "ultra"] },
  ]),
  listCopilotModels: vi.fn(async () => ["claude-sonnet-5", "gpt-5.5"]),
  listAntigravityModels: vi.fn(async () => [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  ]),
  // Keep the auto-fallback disabled so it never hijacks the explicit provider.
  detectClaudeCli: vi.fn(async () => ({
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  })),
}));

vi.mock("../utils/backend", () => ({
  claudeCliPrompt,
  codexCliPrompt,
  opencodeCliPrompt,
  copilotCliPrompt,
  listOpencodeModels,
  listAntigravityModels,
  listCopilotModels,
  listCodexModels,
  detectClaudeCli,
}));

import {
  useAIProvider,
  modelForProvider,
  effortForProvider,
  fetchAnthropicModels,
  listModelsForProvider,
  CLAUDE_CODE_MODELS,
  CLAUDE_API_MODELS,
  DEFAULT_CLAUDE_API_MODEL,
  fallbackModelsForProvider,
  isFetchableEndpoint,
  isStaleEffort,
  type AISettings,
} from "../composables/useAIProvider";

function setSettings(partial: Record<string, unknown>) {
  localStorage.setItem(
    "gitwand-settings",
    JSON.stringify({ aiEnabled: true, ...partial }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("modelForProvider", () => {
  const s = {
    aiModelByProvider: {
      "opencode-cli": "anthropic/claude-x",
      "codex-cli": "",
    },
  } as unknown as AISettings;

  it("returns the per-provider model for CLI agents", () => {
    expect(modelForProvider(s, "opencode-cli")).toBe("anthropic/claude-x");
  });

  it("treats an empty per-provider model as 'use CLI default'", () => {
    expect(modelForProvider(s, "codex-cli")).toBeUndefined();
  });

  it("returns undefined for non-CLI providers", () => {
    expect(modelForProvider(s, "claude")).toBeUndefined();
    expect(modelForProvider(s, "ollama")).toBeUndefined();
  });

  it("returns undefined when no model is stored for the CLI agent", () => {
    expect(
      modelForProvider({ aiModelByProvider: {} } as unknown as AISettings, "claude-code-cli"),
    ).toBeUndefined();
  });
});

describe("listModelsForProvider", () => {
  it("advertises curated aliases for Claude Code", async () => {
    expect(await listModelsForProvider("claude-code-cli")).toEqual(CLAUDE_CODE_MODELS);
  });

  it("enumerates the Codex catalog with per-model efforts", async () => {
    expect(await listModelsForProvider("codex-cli")).toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "ultra"] },
    ]);
  });

  it("enumerates Copilot models with Copilot's effort range", async () => {
    const models = await listModelsForProvider("copilot-cli");
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5", "gpt-5.5"]);
    expect(models[0].efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("enumerates opencode models dynamically", async () => {
    const models = await listModelsForProvider("opencode-cli");
    expect(models).toEqual([
      { id: "anthropic/claude-x", name: "anthropic/claude-x", efforts: [] },
      { id: "openai/gpt-y", name: "openai/gpt-y", efforts: [] },
    ]);
    expect(listOpencodeModels).toHaveBeenCalledTimes(1);
  });

  it("enumerates Antigravity models with their display name", async () => {
    expect(await listModelsForProvider("antigravity-cli")).toEqual([
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", efforts: [] },
    ]);
  });

});

describe("effortForProvider", () => {
  const s = {
    aiEffortByProvider: { "claude-code-cli": "xhigh", "codex-cli": "bogus", claude: "" },
  } as unknown as AISettings;

  it("returns a known effort level", () => {
    expect(effortForProvider(s, "claude-code-cli")).toBe("xhigh");
  });

  it("drops unknown or empty levels", () => {
    expect(effortForProvider(s, "codex-cli")).toBeUndefined();
    expect(effortForProvider(s, "claude")).toBeUndefined();
    expect(effortForProvider(s, "copilot-cli")).toBeUndefined();
  });
});

describe("rawPrompt provider dispatch", () => {
  it("routes opencode-cli to opencodeCliPrompt with the selected model", async () => {
    setSettings({
      aiProvider: "opencode-cli",
      aiModelByProvider: { "opencode-cli": "anthropic/claude-x" },
    });
    const { rawPrompt } = useAIProvider();
    const out = await rawPrompt("sys", "user");
    expect(out).toBe("ok-opencode");
    expect(opencodeCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, "anthropic/claude-x");
  });

  it("forwards the per-provider model to Codex", async () => {
    setSettings({
      aiProvider: "codex-cli",
      aiModelByProvider: { "codex-cli": "gpt-5-codex" },
    });
    await useAIProvider().rawPrompt("sys", "user");
    expect(codexCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, "gpt-5-codex", undefined);
  });

  it("forwards the per-provider model to Claude Code", async () => {
    setSettings({
      aiProvider: "claude-code-cli",
      aiModelByProvider: { "claude-code-cli": "opus" },
    });
    await useAIProvider().rawPrompt("sys", "user");
    expect(claudeCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, "text", "opus", undefined);
  });

  it("routes copilot-cli to copilotCliPrompt with the selected model", async () => {
    setSettings({
      aiProvider: "copilot-cli",
      aiModelByProvider: { "copilot-cli": "gpt-5" },
    });
    const out = await useAIProvider().rawPrompt("sys", "user");
    expect(out).toBe("ok-copilot");
    expect(copilotCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, "gpt-5", undefined);
  });

  it("forwards the per-provider effort to Claude Code, Codex and Copilot", async () => {
    setSettings({
      aiProvider: "claude-code-cli",
      aiEffortByProvider: { "claude-code-cli": "max", "codex-cli": "high", "copilot-cli": "low" },
    });
    await useAIProvider().rawPrompt("sys", "user");
    expect(claudeCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, "text", undefined, "max");

    setSettings({ aiProvider: "codex-cli", aiEffortByProvider: { "codex-cli": "high" } });
    await useAIProvider().rawPrompt("sys", "user");
    expect(codexCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, undefined, "high");

    setSettings({ aiProvider: "copilot-cli", aiEffortByProvider: { "copilot-cli": "low" } });
    await useAIProvider().rawPrompt("sys", "user");
    expect(copilotCliPrompt).toHaveBeenCalledWith("user", "sys", undefined, undefined, "low");
  });

  it("passes undefined when no model is configured (CLI default)", async () => {
    setSettings({ aiProvider: "opencode-cli", aiModelByProvider: {} });
    await useAIProvider().rawPrompt("s", "u");
    expect(opencodeCliPrompt).toHaveBeenCalledWith("u", "s", undefined, undefined);
  });
});

describe("fetchAnthropicModels", () => {
  it("maps display name, id and supported effort levels, following pages", async () => {
    const pages = [
      {
        data: [
          {
            id: "claude-opus-5-5",
            display_name: "Claude Opus 5.5",
            capabilities: {
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                xhigh: { supported: true },
                max: { supported: true },
              },
            },
          },
        ],
        has_more: true,
        last_id: "claude-opus-5-5",
      },
      {
        data: [
          {
            id: "claude-haiku-4-5",
            display_name: "Claude Haiku 4.5",
            capabilities: { effort: { supported: false, low: { supported: false } } },
          },
        ],
        has_more: false,
        last_id: "claude-haiku-4-5",
      },
    ];
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      urls.push(String(url));
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
      return new Response(JSON.stringify(pages.shift()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const models = await fetchAnthropicModels("https://api.anthropic.com/", "sk-test");
      expect(models).toEqual([
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", efforts: [] },
      ]);
      expect(urls[0]).toBe("https://api.anthropic.com/v1/models?limit=1000");
      expect(urls[1]).toContain("after_id=claude-opus-5-5");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on an API error so the panel can show why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    try {
      await expect(fetchAnthropicModels("", "sk-bad")).rejects.toThrow(/401/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Claude API default list", () => {
  it("offers current models with their efforts before a key is entered", async () => {
    const models = await listModelsForProvider("claude", { aiApiKey: "", aiApiEndpoint: "" });
    expect(models).toBe(CLAUDE_API_MODELS);
    expect(models.map((m) => m.id)).toContain(DEFAULT_CLAUDE_API_MODEL);
  });

  it("lists only real model ids, and Haiku 4.5 takes no effort", () => {
    const ids = CLAUDE_API_MODELS.map((m) => m.id);
    expect(ids).not.toContain("claude-haiku-5-5");
    const haiku = CLAUDE_API_MODELS.find((m) => m.id === "claude-haiku-4-5-20251001");
    expect(haiku).toBeDefined();
    expect(haiku!.efforts).toEqual([]);
  });

  it("falls back to that list only for the Claude API", () => {
    expect(fallbackModelsForProvider("claude")).toBe(CLAUDE_API_MODELS);
    expect(fallbackModelsForProvider("openai-compat")).toEqual([]);
  });
});

describe("isFetchableEndpoint", () => {
  it("accepts a complete http(s) URL with a host", () => {
    expect(isFetchableEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isFetchableEndpoint("http://localhost:11434/v1")).toBe(true);
  });

  it("refuses half-typed or non-http endpoints, so the key is not sent there", () => {
    for (const e of ["", "   ", "https://", "https:/", "api.openai.com", "ftp://host/x", "http://"]) {
      expect(isFetchableEndpoint(e), e).toBe(false);
    }
  });
});

describe("isStaleEffort", () => {
  it("is stale when a saved effort is absent from the loaded model's options", () => {
    expect(isStaleEffort("max", ["low", "medium"], true)).toBe(true);
    expect(isStaleEffort("low", ["low", "medium"], true)).toBe(false);
    // A model with no effort at all (Haiku 4.5) invalidates any saved one.
    expect(isStaleEffort("high", [], true)).toBe(true);
  });

  it("never clears while the list is not loaded, or when nothing is saved", () => {
    expect(isStaleEffort("max", [], false)).toBe(false);
    expect(isStaleEffort("", ["low"], true)).toBe(false);
  });
});
