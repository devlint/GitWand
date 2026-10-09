// backend-ai.ts — Claude Code CLI and Codex CLI wrappers.
// Extracted from backend.ts as part of the v2.11 backend split to keep module size manageable.
// Consumers should import directly from this file instead of backend.ts for these symbols.

import { isTauri, tauriInvoke, devFetch, DEV_SERVER, IPC_TIMEOUT } from "./backend-core";

// ─── Claude Code CLI wrapper ─────────────────────────────
//
// Thin wrappers around the Rust/dev-server commands that shell out to the
// user's locally-installed `claude` binary (official Claude Code CLI).
// This is how we piggyback on the user's Max/Pro subscription without
// implementing OAuth ourselves — same trick as Solo / SoloTerm.

export interface ClaudeCliInfo {
  /** True when the `claude` binary was found on disk. */
  found: boolean;
  /** Absolute path to the binary, or "" if not found. */
  path: string;
  /** Raw `claude --version` output. */
  version: string;
  /** True if a ping prompt answered without an auth error. */
  logged_in: boolean;
  /** Machine-readable status: "ok" | "not_found" | "not_logged_in" | "error". */
  status: "ok" | "not_found" | "not_logged_in" | "error" | string;
  /** Optional error detail line. */
  detail: string;
}

/**
 * Detect whether the Claude Code CLI is installed and authenticated.
 * Safe to call on app boot — returns `found: false` instead of throwing
 * when the binary is missing.
 */
export async function detectClaudeCli(): Promise<ClaudeCliInfo> {
  if (isTauri()) {
    return tauriInvoke<ClaudeCliInfo>("detect_claude_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/claude-cli-detect`);
    if (res.ok) return (await res.json()) as ClaudeCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local Claude Code CLI.
 *
 * @param prompt User prompt (main content).
 * @param systemPrompt Optional system-level instructions (prepended as a
 *                     `# System` section since `claude -p` has no separate
 *                     system channel).
 * @param cwd Optional working directory for the CLI process.
 * @param outputFormat "text" (default) or "json".
 * @returns Raw stdout from the CLI.
 */
export async function claudeCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
  outputFormat: "text" | "json" = "text",
  model?: string,
  effort?: string,
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("claude_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
      outputFormat,
      model,
      effort,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/claude-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd, outputFormat, model, effort }),
  });
  if (!res.ok) {
    let msg = `claude CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

// ─── Codex CLI provider (v2.0) ─────────────────────────────
// Mirrors the Claude CLI shape — same struct, different binary. Codex CLI
// uses `codex exec "<prompt>"` for non-interactive runs and authenticates
// via OAuth (`codex login`) or `OPENAI_API_KEY`.

export interface CodexCliInfo {
  found: boolean;
  path: string;
  version: string;
  logged_in: boolean;
  status: "ok" | "not_found" | "not_logged_in" | "error" | string;
  detail: string;
}

/**
 * Detect whether the OpenAI Codex CLI is installed and authenticated.
 * Safe to call on app boot.
 */
export async function detectCodexCli(): Promise<CodexCliInfo> {
  if (isTauri()) {
    return tauriInvoke<CodexCliInfo>("detect_codex_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/codex-cli-detect`);
    if (res.ok) return (await res.json()) as CodexCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local Codex CLI (`codex exec`).
 */
export async function codexCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
  model?: string,
  effort?: string,
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("codex_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
      model,
      effort,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/codex-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd, model, effort }),
  });
  if (!res.ok) {
    let msg = `codex CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

/** One entry of Codex's model catalog (`codex debug models`). */
export interface CodexModel {
  /** Value passed to `codex exec --model`, e.g. `gpt-6.1-sol`. */
  id: string;
  /** Display name, e.g. `GPT-6.1-Sol`. */
  name: string;
  /** Reasoning efforts the model accepts, in Codex's order. */
  efforts: string[];
}

/**
 * Enumerate Codex's model catalog (`codex debug models`). Returns an empty
 * array — never throws — when the binary is missing or the command fails, so
 * callers can fall back to free-text entry.
 */
export async function listCodexModels(): Promise<CodexModel[]> {
  if (isTauri()) {
    try {
      return await tauriInvoke<CodexModel[]>("codex_list_models");
    } catch {
      return [];
    }
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/codex-models`);
    if (res.ok) {
      const body = await res.json();
      return Array.isArray(body?.models) ? body.models : [];
    }
  } catch {
    // Dev server unavailable
  }
  return [];
}

// ─── opencode CLI provider (v2.17) ─────────────────────────
// Mirrors the Claude / Codex CLI shape. opencode runs one-shot prompts via
// `opencode run [--model provider/model] "<prompt>"` and enumerates its
// configured catalog via `opencode models` (returns `provider/model` lines).

export interface OpencodeCliInfo {
  found: boolean;
  path: string;
  version: string;
  logged_in: boolean;
  status: "ok" | "not_found" | "not_logged_in" | "error" | "detected" | string;
  detail: string;
}

/**
 * Detect whether the opencode CLI is installed. Safe to call on app boot.
 */
export async function detectOpencodeCli(): Promise<OpencodeCliInfo> {
  if (isTauri()) {
    return tauriInvoke<OpencodeCliInfo>("detect_opencode_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/opencode-cli-detect`);
    if (res.ok) return (await res.json()) as OpencodeCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local opencode CLI (`opencode run`).
 * `model` is the `provider/model` identifier (e.g. `anthropic/claude-…`).
 */
export async function opencodeCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
  model?: string,
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("opencode_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
      model,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/opencode-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd, model }),
  });
  if (!res.ok) {
    let msg = `opencode CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

/**
 * Enumerate the models opencode knows about (`opencode models`). Returns an
 * empty array — never throws — when the binary is missing or the command
 * fails, so callers can fall back to free-text entry.
 */
export async function listOpencodeModels(): Promise<string[]> {
  if (isTauri()) {
    try {
      return await tauriInvoke<string[]>("opencode_list_models");
    } catch {
      return [];
    }
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/opencode-models`);
    if (res.ok) {
      const body = await res.json();
      return Array.isArray(body?.models) ? body.models : [];
    }
  } catch {
    // Dev server unavailable
  }
  return [];
}

// ─── GitHub Copilot CLI provider ───────────────────────────
// Mirrors the Claude / Codex / opencode CLI shape. Copilot runs one-shot
// prompts via `copilot -p "<prompt>" [--model <m>] --no-color`; the response
// is printed to stdout while the credits/tokens footer goes to stderr.

export interface CopilotCliInfo {
  found: boolean;
  path: string;
  version: string;
  logged_in: boolean;
  status: "ok" | "not_found" | "not_logged_in" | "error" | "detected" | string;
  detail: string;
}

/**
 * Detect whether the GitHub Copilot CLI is installed. Safe to call on app boot.
 */
export async function detectCopilotCli(): Promise<CopilotCliInfo> {
  if (isTauri()) {
    return tauriInvoke<CopilotCliInfo>("detect_copilot_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/copilot-cli-detect`);
    if (res.ok) return (await res.json()) as CopilotCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local GitHub Copilot CLI (`copilot -p`).
 */
export async function copilotCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
  model?: string,
  effort?: string,
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("copilot_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
      model,
      effort,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/copilot-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd, model, effort }),
  });
  if (!res.ok) {
    let msg = `copilot CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

/**
 * Enumerate the models Copilot accepts (parsed from `copilot help config`).
 * Returns an empty array — never throws — when the binary is missing or the
 * command fails, so callers can fall back to free-text entry.
 */
export async function listCopilotModels(): Promise<string[]> {
  if (isTauri()) {
    try {
      return await tauriInvoke<string[]>("copilot_list_models");
    } catch {
      return [];
    }
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/copilot-models`);
    if (res.ok) {
      const body = await res.json();
      return Array.isArray(body?.models) ? body.models : [];
    }
  } catch {
    // Dev server unavailable
  }
  return [];
}

// ─── Antigravity CLI provider ──────────────────────────────
// Mirrors the Claude / Codex / opencode / Copilot CLI shape. Antigravity runs
// one-shot prompts via `agy -p "<prompt>" [--model <m>]`. Auth is managed by
// Antigravity itself — GitWand just shells out.

export interface AntigravityCliInfo {
  found: boolean;
  path: string;
  version: string;
  logged_in: boolean;
  status: "ok" | "not_found" | "not_logged_in" | "error" | "detected" | string;
  detail: string;
}

/**
 * Detect whether the Antigravity CLI is installed. Safe to call on app boot.
 */
export async function detectAntigravityCli(): Promise<AntigravityCliInfo> {
  if (isTauri()) {
    return tauriInvoke<AntigravityCliInfo>("detect_antigravity_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/antigravity-cli-detect`);
    if (res.ok) return (await res.json()) as AntigravityCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local Antigravity CLI (`agy -p`).
 */
export async function antigravityCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
  model?: string,
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("antigravity_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
      model,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/antigravity-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd, model }),
  });
  if (!res.ok) {
    let msg = `antigravity CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

/** One entry of `agy models`. The effort level is part of the id. */
export interface AntigravityModel {
  /** Value passed to `agy --model`, e.g. `gemini-3.8-flash-high`. */
  id: string;
  /** Human-readable name, e.g. `Gemini 3.8 Flash (High)`. */
  name: string;
}

/**
 * Enumerate the models Antigravity offers (`agy models`). Returns an empty
 * array — never throws — when the binary is missing or the command fails, so
 * callers can fall back to free-text entry.
 */
export async function listAntigravityModels(): Promise<AntigravityModel[]> {
  if (isTauri()) {
    try {
      return await tauriInvoke<AntigravityModel[]>("antigravity_list_models");
    } catch {
      return [];
    }
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/antigravity-models`);
    if (res.ok) {
      const body = await res.json();
      return Array.isArray(body?.models) ? body.models : [];
    }
  } catch {
    // Dev server unavailable
  }
  return [];
}

/**
 * Open the native terminal with `claude login` so the user can complete
 * the OAuth-style setup. Not a PTY integration — just a one-shot bootstrap.
 */
export async function claudeCliLogin(): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("claude_cli_login");
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/claude-cli-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let msg = `claude login failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
}

// ─── AI provider HTTP (Anthropic API / OpenAI-compatible / Ollama) ─────────
//
// The webview no longer fetch()es AI hosts itself: the request goes through
// the Rust `ai_http_request` command, which injects the API key from the OS
// keychain. The key is stored with `aiApiKeySet` and is never readable back
// from the webview — only a masked hint is (see commands/ai_http.rs).

/** How the stored key is attached to an AI request. */
export type AiHttpAuth = "anthropic" | "bearer" | "none";

export interface AiHttpResponse {
  status: number;
  body: string;
}

/** Perform one AI provider HTTP request through the backend. */
export async function aiHttpRequest(
  method: "GET" | "POST",
  url: string,
  auth: AiHttpAuth,
  body?: unknown,
  timeoutSecs?: number,
): Promise<AiHttpResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (isTauri()) {
    return tauriInvoke<AiHttpResponse>("ai_http_request", {
      method,
      url,
      body: payload,
      auth,
      timeoutSecs,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/ai-http-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, url, body: payload, auth, timeoutSecs }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `AI request failed: ${res.status}`);
  return data as AiHttpResponse;
}

/**
 * Store the AI API key in the OS keychain (an empty key clears it). Returns
 * the masked hint of what is now stored, or null when nothing is.
 */
export async function aiApiKeySet(key: string): Promise<string | null> {
  if (isTauri()) return tauriInvoke<string | null>("ai_api_key_set", { key });
  const res = await devFetch(`${DEV_SERVER}/api/ai-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ai_api_key_set failed");
  return data?.hint ?? null;
}

/** Masked hint of the stored AI API key, or null when none is configured. */
export async function aiApiKeyHint(): Promise<string | null> {
  if (isTauri()) return tauriInvoke<string | null>("ai_api_key_hint");
  try {
    const res = await devFetch(`${DEV_SERVER}/api/ai-api-key`);
    if (!res.ok) return null;
    return (await res.json())?.hint ?? null;
  } catch {
    return null;
  }
}

// ─── Launch telemetry opt-out ─────────────────────────────

export interface TelemetryState {
  /** The user setting. */
  enabled: boolean;
  /** True when DO_NOT_TRACK / GITWAND_NO_TELEMETRY forces it off. */
  forced_off_by_env: boolean;
}

export async function telemetryGetState(): Promise<TelemetryState> {
  if (isTauri()) return tauriInvoke<TelemetryState>("telemetry_get_state");
  const res = await devFetch(`${DEV_SERVER}/api/telemetry-state`);
  return (await res.json()) as TelemetryState;
}

export async function telemetrySetEnabled(enabled: boolean): Promise<void> {
  if (isTauri()) return tauriInvoke<void>("telemetry_set_enabled", { enabled });
  await devFetch(`${DEV_SERVER}/api/telemetry-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}
