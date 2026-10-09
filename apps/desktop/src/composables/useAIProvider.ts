import { ref, computed } from "vue";
import type { LlmEndpoint } from "@gitwand/core";
import {
  claudeCliPrompt,
  codexCliPrompt,
  opencodeCliPrompt,
  copilotCliPrompt,
  antigravityCliPrompt,
  listOpencodeModels,
  listAntigravityModels,
  listCopilotModels,
  listCodexModels,
  detectClaudeCli,
} from "../utils/backend";
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
 * - `opencode-cli`   : piggyback on the user's locally-installed opencode
 *                     CLI (`opencode run`) — uses whatever provider they've
 *                     authenticated via `opencode auth login` (v2.17)
 * - `copilot-cli`    : piggyback on the user's locally-installed GitHub
 *                     Copilot CLI (`copilot -p`) — uses their Copilot
 *                     subscription stored on the machine, no API key needed
 * - `antigravity-cli`: piggyback on the user's locally-installed Antigravity
 *                     CLI (`agy -p`) — uses the auth stored on the machine,
 *                     no API key needed
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
  | "opencode-cli"
  | "copilot-cli"
  | "antigravity-cli"
  | "openai-compat"
  | "ollama"
  | "mcp";

/** CLI agent providers that support a per-provider model picker (v2.17). */
export type CliAgentProvider =
  | "claude-code-cli"
  | "codex-cli"
  | "opencode-cli"
  | "copilot-cli"
  | "antigravity-cli";

export const CLI_AGENT_PROVIDERS: CliAgentProvider[] = [
  "claude-code-cli",
  "codex-cli",
  "opencode-cli",
  "copilot-cli",
  "antigravity-cli",
];

export interface AISettings {
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiApiKey: string;
  aiApiEndpoint: string;
  aiModel: string;
  aiOllamaUrl: string;
  aiOllamaModel: string;
  /**
   * Per-provider model selection for the CLI agents (v2.17). Keyed by
   * provider id; the active model for a CLI provider is read from here so
   * switching providers restores each one's previous choice. An absent /
   * empty value means "let the CLI use its own configured default".
   */
  aiModelByProvider: Partial<Record<AIProvider, string>>;
  /**
   * Per-provider reasoning effort (`low` … `max`). Keyed like
   * `aiModelByProvider`; empty means "the model's / CLI's own default".
   * Used by the Claude API (`output_config.effort`) and the CLIs that take
   * an effort flag (Claude Code, Codex, Copilot).
   */
  aiEffortByProvider: Partial<Record<AIProvider, string>>;
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
  /**
   * v3.11.1 — Rendered "Why each side changed these lines" section from
   * `@gitwand/core`'s `renderHistorySection`. Replaces the never-filled
   * per-branch commit-message slots.
   */
  history?: string;
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
    aiModel: DEFAULT_CLAUDE_API_MODEL,
    aiOllamaUrl: "http://localhost:11434",
    aiOllamaModel: "codellama",
    aiModelByProvider: {},
    aiEffortByProvider: {},
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
export function buildUserPrompt(ctx: ConflictContext): string {
  let prompt = `File: ${ctx.filePath}\n\n`;

  if (ctx.history) {
    prompt += `${ctx.history}\n\n`;
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
      ...(effortForProvider(settings, "claude")
        ? { output_config: { effort: effortForProvider(settings, "claude") } }
        : {}),
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
  model?: string,
  effort?: string,
): Promise<string> {
  const result = await claudeCliPrompt(userPrompt, systemPrompt, undefined, "text", model, effort);
  return result ?? "";
}

/**
 * Call the local Codex CLI (`codex exec`). Uses the user's ChatGPT
 * subscription via `codex login`, or `OPENAI_API_KEY` env.
 */
async function callCodexCli(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  effort?: string,
): Promise<string> {
  const result = await codexCliPrompt(userPrompt, systemPrompt, undefined, model, effort);
  return result ?? "";
}

/**
 * Call the local opencode CLI (`opencode run`). Uses whatever provider the
 * user authenticated via `opencode auth login`. `model` is the
 * `provider/model` identifier (v2.17).
 */
async function callOpencodeCli(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
): Promise<string> {
  const result = await opencodeCliPrompt(userPrompt, systemPrompt, undefined, model);
  return result ?? "";
}

/**
 * Call the local GitHub Copilot CLI (`copilot -p`). Uses the user's Copilot
 * subscription stored on the machine — no API key required.
 */
async function callCopilotCli(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  effort?: string,
): Promise<string> {
  const result = await copilotCliPrompt(userPrompt, systemPrompt, undefined, model, effort);
  return result ?? "";
}

/**
 * Call the local Antigravity CLI (`agy -p`). Uses the auth stored on the
 * machine — no API key required.
 */
async function callAntigravityCli(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
): Promise<string> {
  const result = await antigravityCliPrompt(userPrompt, systemPrompt, undefined, model);
  return result ?? "";
}

// ─── Per-provider model selection (v2.17) ───────────────
//
// Each provider exposes a model picker fed by whatever the provider can
// enumerate: the Claude API and OpenAI-compatible endpoints are fetched
// (`GET /v1/models`, `GET /models`), the CLIs are asked through their own
// commands (`opencode models`, `agy models`, `copilot help config`, `codex
// debug models`), and Claude Code accepts stable aliases. An empty list (CLI
// missing, command failed) makes the Settings panel render a free-text input.

/** Every effort level, in increasing order. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** A model the Settings picker can offer. */
export interface AIModelOption {
  /** Value sent to the provider (`model` field / `--model` flag). */
  id: string;
  /** Human-readable name with its version, e.g. "Claude Opus 5.5". */
  name: string;
  /**
   * Effort levels this model accepts, in increasing order. Empty when the
   * provider takes no effort parameter, or bakes it into the id (Antigravity).
   */
  efforts: string[];
}

/** `copilot --reasoning-effort` possible values. */
const COPILOT_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Effort levels every current Claude model accepts. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Default model for the Claude API provider. */
export const DEFAULT_CLAUDE_API_MODEL = "claude-opus-5-5";

/**
 * Current-generation Claude API models — what the picker shows before a key
 * is entered, or when `GET /v1/models` fails. With a working key the live
 * list replaces it.
 */
export const CLAUDE_API_MODELS: AIModelOption[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: CLAUDE_EFFORTS },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: CLAUDE_EFFORTS },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: CLAUDE_EFFORTS },
  // Haiku 4.5 does not support the effort parameter.
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", efforts: [] },
];

/**
 * The list to show when a provider's own list is unavailable (no key yet,
 * fetch failed). Empty = free-text entry.
 */
export function fallbackModelsForProvider(provider: AIProvider): AIModelOption[] {
  return provider === "claude" ? CLAUDE_API_MODELS : [];
}

/** Effort levels `claude --effort` accepts. */
const CLAUDE_CODE_EFFORTS = CLAUDE_EFFORTS;

/** Stable model aliases accepted by `claude --model`. */
export const CLAUDE_CODE_MODELS: AIModelOption[] = [
  { id: "fable", name: "Fable (latest)", efforts: CLAUDE_CODE_EFFORTS },
  { id: "opus", name: "Opus (latest)", efforts: CLAUDE_CODE_EFFORTS },
  { id: "sonnet", name: "Sonnet (latest)", efforts: CLAUDE_CODE_EFFORTS },
  { id: "haiku", name: "Haiku (latest)", efforts: [] },
];

/**
 * Effort levels a provider accepts when the model list cannot say — free-text
 * models (Codex, Copilot) or a model typed by hand. Empty = no effort picker.
 */
export function providerEfforts(provider: AIProvider): string[] {
  switch (provider) {
    case "claude-code-cli":
      return CLAUDE_CODE_EFFORTS;
    case "copilot-cli":
      return COPILOT_EFFORTS;
    case "codex-cli":
      // For a model typed by hand: the levels every catalog model accepts.
      return ["low", "medium", "high"];
    default:
      return [];
  }
}

/**
 * Resolve the model string to pass to a CLI provider, or `undefined` to let
 * the CLI use its own configured default. Only CLI agents are model-scoped
 * here; the Claude API / OpenAI-compat / Ollama providers carry their model
 * in their own settings field.
 */
export function modelForProvider(
  s: AISettings,
  provider: AIProvider,
): string | undefined {
  if ((CLI_AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    const m = s.aiModelByProvider?.[provider];
    return m && m.trim() ? m.trim() : undefined;
  }
  return undefined;
}

/**
 * Resolve the effort to send to a provider, or `undefined` to keep the
 * model's own default. Unknown values are dropped rather than forwarded.
 */
export function effortForProvider(
  s: AISettings,
  provider: AIProvider,
): string | undefined {
  const e = s.aiEffortByProvider?.[provider]?.trim();
  return e && (EFFORT_LEVELS as readonly string[]).includes(e) ? e : undefined;
}

/**
 * True for a complete http(s) URL with a host. Gates the model fetch that
 * carries the API key: a half-typed endpoint must not receive it.
 */
export function isFetchableEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * A saved effort the current model no longer accepts. Only judged once the
 * model list has loaded: while it is loading or empty the options are not
 * known yet. An empty option list on a loaded list is meaningful (Haiku 4.5
 * accepts no effort).
 */
export function isStaleEffort(effort: string, options: string[], listLoaded: boolean): boolean {
  return listLoaded && effort !== "" && !options.includes(effort);
}

/** Effort levels a Claude `/v1/models` entry reports as supported. */
function anthropicEfforts(capabilities: any): string[] {
  const effort = capabilities?.effort;
  if (!effort?.supported) return [];
  return EFFORT_LEVELS.filter((level) => effort[level]?.supported === true);
}

/**
 * Fetch the models the Anthropic API key can use (`GET /v1/models`), newest
 * first as the API returns them.
 */
export async function fetchAnthropicModels(
  endpoint: string,
  apiKey: string,
): Promise<AIModelOption[]> {
  const base = (endpoint || "https://api.anthropic.com").replace(/\/+$/, "");
  const models: AIModelOption[] = [];
  let afterId: string | undefined;
  // Paginate defensively; a handful of pages at most in practice.
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${base}/v1/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    for (const m of body.data ?? []) {
      if (!m?.id) continue;
      models.push({
        id: m.id,
        name: m.display_name || m.id,
        efforts: anthropicEfforts(m.capabilities),
      });
    }
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }
  return models;
}

/**
 * Fetch the models an OpenAI-compatible endpoint serves (`GET /models`).
 * The endpoint reports ids only — no display name, no effort support.
 */
export async function fetchOpenAICompatModels(
  endpoint: string,
  apiKey: string,
): Promise<AIModelOption[]> {
  const base = endpoint.replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return (body.data ?? [])
    .map((m: any) => m?.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b))
    .map((id: string) => ({ id, name: id, efforts: [] }));
}

/**
 * List the models a provider advertises, for the Settings model picker.
 * Returns an empty array (→ free-text fallback) when no list is available.
 * The API providers need the endpoint and key from `s`; a failed fetch
 * throws so the panel can say why the list is empty.
 */
export async function listModelsForProvider(
  provider: AIProvider,
  s?: Pick<AISettings, "aiApiEndpoint" | "aiApiKey">,
): Promise<AIModelOption[]> {
  switch (provider) {
    case "claude":
      if (!s?.aiApiKey) return CLAUDE_API_MODELS;
      return fetchAnthropicModels(s.aiApiEndpoint, s.aiApiKey);
    case "openai-compat":
      if (!s?.aiApiEndpoint) return [];
      return fetchOpenAICompatModels(s.aiApiEndpoint, s.aiApiKey);
    case "opencode-cli":
      return (await listOpencodeModels()).map((id) => ({ id, name: id, efforts: [] }));
    case "antigravity-cli":
      return (await listAntigravityModels()).map((m) => ({ id: m.id, name: m.name, efforts: [] }));
    case "copilot-cli":
      // Copilot reports ids only, and one effort range for every model.
      return (await listCopilotModels()).map((id) => ({ id, name: id, efforts: COPILOT_EFFORTS }));
    case "codex-cli":
      return listCodexModels();
    case "claude-code-cli":
      return CLAUDE_CODE_MODELS;
    default:
      return [];
  }
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

// ─── Auto-detection ─────────────────────────────────────
// Populated once at module load; null = detection still pending.
const _claudeCliAvailable = ref<boolean | null>(null);

detectClaudeCli().then(info => {
  _claudeCliAvailable.value = info.found && info.logged_in;
}).catch(() => {
  _claudeCliAvailable.value = false;
});

// ─── Composable ─────────────────────────────────────────
const isLoading = ref(false);
const lastError = ref<string | null>(null);
const lastSuggestion = ref<AISuggestion | null>(null);

export function useAIProvider() {
  const settings = computed(() => loadAISettings());

  const isAvailable = computed(() => {
    const s = settings.value;
    if (s.aiEnabled) {
      if (s.aiProvider === "claude" && s.aiApiKey) return true;
      if (s.aiProvider === "openai-compat" && s.aiApiKey && s.aiApiEndpoint) return true;
      if (s.aiProvider === "ollama") return true;
      if (s.aiProvider === "claude-code-cli") return true;
      if (s.aiProvider === "codex-cli") return true;
      if (s.aiProvider === "opencode-cli") return true;
      if (s.aiProvider === "copilot-cli") return true;
      if (s.aiProvider === "antigravity-cli") return true;
      // misconfigured explicit provider — fall through to CLI auto-detect
    }
    // Auto-fallback: use Claude Code CLI if installed and logged in,
    // even when the user hasn't configured any explicit AI provider.
    return _claudeCliAvailable.value === true;
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

      const misconfigured =
        !s.aiEnabled ||
        s.aiProvider === "none" ||
        (s.aiProvider === "claude" && !s.aiApiKey) ||
        (s.aiProvider === "openai-compat" && (!s.aiApiKey || !s.aiApiEndpoint));
      const provider = misconfigured && _claudeCliAvailable.value
        ? "claude-code-cli"
        : s.aiProvider;
      const model = modelForProvider(s, provider);
      const effort = effortForProvider(s, provider);

      switch (provider) {
        case "claude":
          rawResponse = await callClaude(s, systemPrompt, userPrompt);
          break;
        case "claude-code-cli":
          rawResponse = await callClaudeCodeCli(systemPrompt, userPrompt, model, effort);
          break;
        case "codex-cli":
          rawResponse = await callCodexCli(systemPrompt, userPrompt, model, effort);
          break;
        case "opencode-cli":
          rawResponse = await callOpencodeCli(systemPrompt, userPrompt, model);
          break;
        case "copilot-cli":
          rawResponse = await callCopilotCli(systemPrompt, userPrompt, model, effort);
          break;
        case "antigravity-cli":
          rawResponse = await callAntigravityCli(systemPrompt, userPrompt, model);
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
    const misconfigured =
      !s.aiEnabled ||
      s.aiProvider === "none" ||
      (s.aiProvider === "claude" && !s.aiApiKey) ||
      (s.aiProvider === "openai-compat" && (!s.aiApiKey || !s.aiApiEndpoint));
    const provider = misconfigured && _claudeCliAvailable.value
      ? "claude-code-cli"
      : s.aiProvider;
    const model = modelForProvider(s, provider);
    const effort = effortForProvider(s, provider);
    switch (provider) {
      case "claude":
        return callClaude(s, systemPrompt, userPrompt);
      case "claude-code-cli":
        return callClaudeCodeCli(systemPrompt, userPrompt, model, effort);
      case "codex-cli":
        return callCodexCli(systemPrompt, userPrompt, model, effort);
      case "opencode-cli":
        return callOpencodeCli(systemPrompt, userPrompt, model);
      case "copilot-cli":
        return callCopilotCli(systemPrompt, userPrompt, model, effort);
      case "antigravity-cli":
        return callAntigravityCli(systemPrompt, userPrompt, model);
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
