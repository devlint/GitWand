import { ref, computed } from "vue";
import type { LlmEndpoint } from "@gitwand/core";
import { claudeCliPrompt, codexCliPrompt } from "../utils/backend";
import { t } from "./useI18n";

/**
 * AI provider types matching SettingsPanel configuration.
 *
 * - `claude`         : direct Anthropic API with user-provided API key
 * - `claude-code-cli`: piggyback on the user's locally-installed Claude Code
 *                     CLI (uses their Max/Pro subscription, no API key needed)
 * - `codex-cli`      : piggyback on the user's locally-installed OpenAI Codex
 *                     CLI (`codex exec`) — uses their ChatGPT
 *                     subscription via `codex login`, or OPENAI_API_KEY
 * - `openai-compat`  : any OpenAI-compatible endpoint
 * - `ollama`         : local Ollama instance
 * - `mcp`            : route the LLM call through a connected MCP agent
 *                     (Claude Code / Cursor / Windsurf via `@gitwand/mcp`).
 *                     v2.5 fallback only — the regular `suggest()` /
 *                     `rawPrompt()` paths still throw for this value
 *                     until the §5 tie-in lands.
 */
export type AIProvider =
  | "none"
  | "claude"
  | "claude-code-cli"
  | "codex-cli"
  | "openai-compat"
  | "ollama"
  | "mcp";

export interface AISettings {
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiApiKey: string;
  aiApiEndpoint: string;
  aiModel: string;
  aiOllamaUrl: string;
  aiOllamaModel: string;
}

export interface ConflictContext {
  /** File path (relative to repo root). */
  filePath: string;
  /** Base version of the conflicted section. */
  base: string;
  /** "Ours" version (current branch). */
  ours: string;
  /** "Theirs" version (incoming branch). */
  theirs: string;
  /** Commit message from our branch (if available). */
  ourCommitMessage?: string;
  /** Commit message from their branch (if available). */
  theirCommitMessage?: string;
  /** Surrounding context (lines before/after the conflict). */
  surroundingContext?: string;
}

export interface AISuggestion {
  /** The suggested resolved content. */
  resolvedContent: string;
  /** Brief explanation of why this resolution was chosen. */
  explanation: string;
  /** Confidence level from the AI (informational). */
  confidence: "high" | "medium" | "low";
}

const SETTINGS_KEY = "gitwand-settings";

/**
 * Read AI settings from localStorage.
 */
function loadAISettings(): AISettings {
  const defaults: AISettings = {
    aiEnabled: false,
    aiProvider: "none",
    aiApiKey: "",
    aiApiEndpoint: "https://api.anthropic.com",
    aiModel: "claude-sonnet-4-20250514",
    aiOllamaUrl: "http://localhost:11434",
    aiOllamaModel: "codellama",
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed };
    }
  } catch { /* ignore */ }
  return defaults;
}

/**
 * Build the system prompt for conflict resolution.
 */
function buildSystemPrompt(): string {
  return `You are a Git merge conflict resolution assistant integrated into GitWand, a desktop Git client.

Your task is to resolve merge conflicts intelligently by analyzing the base version, "ours" (current branch), and "theirs" (incoming branch).

Rules:
1. Produce ONLY the resolved content — no conflict markers, no explanations in the code.
2. Preserve the intent of BOTH branches when possible.
3. If one side is a clear improvement (bug fix, feature addition), prefer it.
4. If both sides modify the same code differently, merge them logically.
5. Respect the file's coding style (indentation, naming conventions).
6. Never invent new logic that wasn't in either version.

Respond in JSON format:
{
  "resolvedContent": "the merged result",
  "explanation": "brief explanation in the user's language",
  "confidence": "high" | "medium" | "low"
}`;
}

/**
 * Build the user prompt with conflict context.
 */
function buildUserPrompt(ctx: ConflictContext): string {
  let prompt = `File: ${ctx.filePath}\n\n`;

  if (ctx.ourCommitMessage || ctx.theirCommitMessage) {
    prompt += `--- Commit context ---\n`;
    if (ctx.ourCommitMessage) prompt += `Our branch: ${ctx.ourCommitMessage}\n`;
    if (ctx.theirCommitMessage) prompt += `Their branch: ${ctx.theirCommitMessage}\n`;
    prompt += `\n`;
  }

  if (ctx.surroundingContext) {
    prompt += `--- Surrounding code ---\n${ctx.surroundingContext}\n\n`;
  }

  prompt += `--- BASE (common ancestor) ---\n${ctx.base}\n\n`;
  prompt += `--- OURS (current branch) ---\n${ctx.ours}\n\n`;
  prompt += `--- THEIRS (incoming branch) ---\n${ctx.theirs}\n\n`;
  prompt += `Resolve this conflict. Return JSON only.`;

  return prompt;
}

/**
 * Call the Anthropic Messages API.
 */
async function callClaude(
  settings: AISettings,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const res = await fetch(`${settings.aiApiEndpoint}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.aiApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.aiModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b: any) => b.type === "text");
  if (!textBlock) throw new Error("No text content in Anthropic response");
  return textBlock.text;
}

/**
 * Call an OpenAI-compatible Chat Completions API.
 */
async function callOpenAICompat(
  settings: AISettings,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const endpoint = settings.aiApiEndpoint.replace(/\/+$/, "");
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
    body: JSON.stringify({
      model: settings.aiModel,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Call the local Claude Code CLI (`claude -p`). Uses the user's Max/Pro
 * subscription — no API key required as long as they've run `claude login`.
 */
async function callClaudeCodeCli(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const result = await claudeCliPrompt(userPrompt, systemPrompt, undefined, "text");
  return result ?? "";
}

/**
 * Call the local Codex CLI (`codex exec`). Uses the user's ChatGPT
 * subscription via `codex login`, or `OPENAI_API_KEY` env.
 */
async function callCodexCli(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const result = await codexCliPrompt(userPrompt, systemPrompt, undefined);
  return result ?? "";
}

/**
 * Call Ollama's local API.
 */
async function callOllama(
  settings: AISettings,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const url = (settings.aiOllamaUrl || "http://localhost:11434").replace(/\/+$/, "");
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.aiOllamaModel || "codellama",
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.message?.content ?? "";
}

/**
 * Parse the AI's JSON response into an AISuggestion.
 */
function parseAIResponse(raw: string): AISuggestion {
  // Try to extract JSON from the response (might have markdown fences)
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      resolvedContent: parsed.resolvedContent ?? parsed.resolved_content ?? raw,
      explanation: parsed.explanation ?? "Résolution suggérée par l'IA",
      confidence: parsed.confidence ?? "medium",
    };
  } catch {
    // If JSON parsing fails, use the raw text as the resolved content
    return {
      resolvedContent: raw,
      explanation: "Résolution suggérée par l'IA (réponse non structurée)",
      confidence: "low",
    };
  }
}

// ─── Composable ─────────────────────────────────────────
const isLoading = ref(false);
const lastError = ref<string | null>(null);
const lastSuggestion = ref<AISuggestion | null>(null);

export function useAIProvider() {
  const settings = computed(() => loadAISettings());

  const isAvailable = computed(() => {
    const s = settings.value;
    if (!s.aiEnabled) return false;
    if (s.aiProvider === "claude" && !s.aiApiKey) return false;
    if (s.aiProvider === "openai-compat" && (!s.aiApiKey || !s.aiApiEndpoint)) return false;
    if (s.aiProvider === "ollama") return true; // Ollama doesn't need a key
    // CLI providers: availability is verified at runtime via the matching
    // detectXxxCli() — optimistically considered available here so the
    // first actual call surfaces a clear error if missing / not logged in.
    if (s.aiProvider === "claude-code-cli") return true;
    if (s.aiProvider === "codex-cli") return true;
    if (s.aiProvider === "none") return false;
    return true;
  });

  /**
   * Request an AI suggestion for a conflict.
   */
  async function suggest(ctx: ConflictContext): Promise<AISuggestion> {
    const s = loadAISettings(); // Fresh read
    isLoading.value = true;
    lastError.value = null;
    lastSuggestion.value = null;

    try {
      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt(ctx);

      let rawResponse: string;

      switch (s.aiProvider) {
        case "claude":
          rawResponse = await callClaude(s, systemPrompt, userPrompt);
          break;
        case "claude-code-cli":
          rawResponse = await callClaudeCodeCli(systemPrompt, userPrompt);
          break;
        case "codex-cli":
          rawResponse = await callCodexCli(systemPrompt, userPrompt);
          break;
        case "openai-compat":
          rawResponse = await callOpenAICompat(s, systemPrompt, userPrompt);
          break;
        case "ollama":
          rawResponse = await callOllama(s, systemPrompt, userPrompt);
          break;
        default:
          throw new Error(t("errors.noAiProviderShort"));
      }

      const suggestion = parseAIResponse(rawResponse);
      lastSuggestion.value = suggestion;
      return suggestion;
    } catch (err: any) {
      lastError.value = err.message || String(err);
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Free-form prompt dispatch — same provider selection as `suggest()`,
   * but without the conflict-resolution-specific scaffolding. Used by
   * commit-message generation, PR summaries, and other single-shot tasks.
   */
  async function rawPrompt(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const s = loadAISettings();
    switch (s.aiProvider) {
      case "claude":
        return callClaude(s, systemPrompt, userPrompt);
      case "claude-code-cli":
        return callClaudeCodeCli(systemPrompt, userPrompt);
      case "codex-cli":
        return callCodexCli(systemPrompt, userPrompt);
      case "openai-compat":
        return callOpenAICompat(s, systemPrompt, userPrompt);
      case "ollama":
        return callOllama(s, systemPrompt, userPrompt);
      default:
        throw new Error(t("errors.noAiProviderShort"));
    }
  }

  /**
   * v2.5 — Adapter for `@gitwand/core`'s `LlmEndpoint` interface.
   *
   * Returns `null` when:
   *   - AI is globally disabled (`aiEnabled === false`)
   *   - No provider is selected (`aiProvider === "none"`)
   *   - The selected provider needs configuration the user hasn't supplied
   *     (Claude API without `aiApiKey`, OpenAI-compat without endpoint/key…)
   *   - The provider is `"mcp"` — the actual wiring is deferred to §5.2 of
   *     PLAN-v2.5-tie-in (Phase 2). For now this lands in `null` so the
   *     LLM fallback is silently skipped instead of hitting the default
   *     `throw` in `rawPrompt()`.
   *
   * When non-null, the returned object's `call()` forwards the (already
   * fully-formatted) prompt produced by `@gitwand/core` to the same
   * provider dispatcher used by `suggest()` and `rawPrompt()`. The system
   * prompt is left empty: the core builds a self-contained prompt that
   * carries its own instructions, so adding a second layer of system
   * preamble would only dilute it.
   */
  function toLlmEndpoint(): LlmEndpoint | null {
    const s = loadAISettings();
    if (!s.aiEnabled || s.aiProvider === "none") return null;
    if (s.aiProvider === "mcp") return null; // wired in PLAN §5.2 (Phase 2)
    if (s.aiProvider === "claude" && !s.aiApiKey) return null;
    if (s.aiProvider === "openai-compat" && (!s.aiApiKey || !s.aiApiEndpoint)) return null;
    return {
      async call(prompt: string): Promise<string> {
        // Forward the core's prompt verbatim — it already contains the
        // base/ours/theirs hunk, surrounding context, and resolution
        // instructions. An empty system prompt avoids double-instructing.
        return rawPrompt("", prompt);
      },
    };
  }

  return {
    isAvailable,
    isLoading,
    lastError,
    lastSuggestion,
    suggest,
    rawPrompt,
    toLlmEndpoint,
  };
}
