/**
 * Endpoints LLM Node — wrappers `fetch` natif (Node 20+) pour les 3 providers
 * supportés par le CLI : Claude (Anthropic), OpenAI, Ollama (local).
 *
 * Le `@gitwand/core` ne fait pas de requête HTTP directe : c'est ici, côté
 * consommateur CLI, que l'on construit un `LlmEndpoint` qui implémente
 * l'interface attendue par `resolveAsync()` (v2.5 — opt-in via `--llm-fallback`).
 *
 * Contrat strict :
 *  - aucune dep npm (fetch natif Node 20+),
 *  - clés API lues uniquement depuis l'environnement (`ANTHROPIC_API_KEY`,
 *    `OPENAI_API_KEY`),
 *  - timeout dur 30 s par requête (`AbortSignal.timeout(30000)`),
 *  - erreurs HTTP / parse explicitement annotées (status + body tronqué 500c),
 *  - jamais de log de la clé API ni du prompt complet.
 */

import type { LlmEndpoint } from "@gitwand/core";

/** Provider supportés par le CLI. */
export type CliLlmProvider = "claude" | "openai" | "ollama";

/** Configuration d'un endpoint LLM côté CLI. */
export interface CliLlmConfig {
  provider: CliLlmProvider;
  model: string;
  /** Clé API : ANTHROPIC_API_KEY / OPENAI_API_KEY. Ignorée pour Ollama. */
  apiKey?: string;
  /** Override URL de base (utile pour Ollama distant). */
  baseUrl?: string;
  /** Plafond tokens dans la réponse LLM. Défaut : 4000. */
  maxTokens?: number;
  /** Température (0.0 = déterministe recommandé). Défaut : 0.0. */
  temperature?: number;
  /** Timeout HTTP en ms. Défaut : 30000. */
  timeoutMs?: number;
}

/** Timeout par défaut pour un appel LLM (30 secondes). */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
/** Plafond par défaut sur les tokens de réponse. */
export const DEFAULT_LLM_MAX_TOKENS = 4000;
/** Température par défaut (déterministe). */
export const DEFAULT_LLM_TEMPERATURE = 0.0;
/** URL Ollama locale par défaut. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * Construit un `LlmEndpoint` à injecter dans `GitWandOptions.llmFallback.endpoint`.
 *
 * Throw au moment de l'appel (pas à la construction) si la clé API requise
 * manque — permet au CLI d'afficher un message ciblé seulement si un hunk
 * `llm_proposed` survient réellement.
 */
export function buildLlmEndpoint(config: CliLlmConfig): LlmEndpoint {
  return {
    async call(prompt: string): Promise<string> {
      switch (config.provider) {
        case "claude":
          return callClaude(prompt, config);
        case "openai":
          return callOpenAI(prompt, config);
        case "ollama":
          return callOllama(prompt, config);
      }
    },
  };
}

// ─── Anthropic Claude ─────────────────────────────────────────

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

async function callClaude(prompt: string, config: CliLlmConfig): Promise<string> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Required for --llm-provider=claude.",
    );
  }

  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    temperature: config.temperature ?? DEFAULT_LLM_TEMPERATURE,
    messages: [{ role: "user", content: prompt }],
  };

  const res = await postJson(CLAUDE_URL, body, {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  }, config.timeoutMs);

  const parsed = await parseJsonResponse(res, "claude");
  // Claude API response shape: { content: [ { type: "text", text: "…" } ], … }
  const first = Array.isArray(parsed?.content) ? parsed.content[0] : undefined;
  const text =
    first && typeof first === "object" && typeof first.text === "string"
      ? first.text
      : null;
  if (text === null) {
    throw new Error("Claude response did not contain content[0].text");
  }
  return text;
}

// ─── OpenAI ──────────────────────────────────────────────────

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function callOpenAI(prompt: string, config: CliLlmConfig): Promise<string> {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      "OPENAI_API_KEY is not set. Required for --llm-provider=openai.",
    );
  }

  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    temperature: config.temperature ?? DEFAULT_LLM_TEMPERATURE,
    messages: [{ role: "user", content: prompt }],
  };

  const res = await postJson(OPENAI_URL, body, {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  }, config.timeoutMs);

  const parsed = await parseJsonResponse(res, "openai");
  // OpenAI chat completions: { choices: [ { message: { content: "…" } } ], … }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
  const text =
    choice &&
    typeof choice === "object" &&
    choice.message &&
    typeof choice.message.content === "string"
      ? choice.message.content
      : null;
  if (text === null) {
    throw new Error("OpenAI response did not contain choices[0].message.content");
  }
  return text;
}

// ─── Ollama (local) ──────────────────────────────────────────

async function callOllama(prompt: string, config: CliLlmConfig): Promise<string> {
  const baseUrl = (config.baseUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(
    /\/+$/,
    "",
  );
  const url = `${baseUrl}/api/chat`;

  const body = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    options: {
      temperature: config.temperature ?? DEFAULT_LLM_TEMPERATURE,
      num_predict: config.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    },
    stream: false,
  };

  const res = await postJson(url, body, { "content-type": "application/json" }, config.timeoutMs);

  const parsed = await parseJsonResponse(res, "ollama");
  // Ollama /api/chat response: { message: { role: "assistant", content: "…" }, … }
  const text =
    parsed?.message && typeof parsed.message === "object" && typeof parsed.message.content === "string"
      ? parsed.message.content
      : null;
  if (text === null) {
    throw new Error("Ollama response did not contain message.content");
  }
  return text;
}

// ─── Helpers HTTP partagés ───────────────────────────────────

/**
 * POST JSON helper avec timeout via `AbortSignal.timeout`. Renvoie la
 * `Response` brute pour permettre à l'appelant de parser ou inspecter
 * `status` selon ses besoins.
 *
 * @throws Error si la réponse a un status non-2xx ou si le fetch échoue
 *               (réseau, timeout). Le corps de réponse est tronqué à 500c
 *               dans le message d'erreur — jamais le prompt complet.
 */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number | undefined,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM request to ${url} failed: ${msg}`);
  }

  if (!res.ok) {
    let bodySnippet = "";
    try {
      const text = await res.text();
      bodySnippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch {
      bodySnippet = "<unable to read response body>";
    }
    throw new Error(
      `LLM request to ${url} returned HTTP ${res.status}: ${bodySnippet}`,
    );
  }

  return res;
}

/**
 * Parse le `Response.body` en JSON. Throw un message explicite (avec le nom
 * du provider) si le parse échoue — utile pour distinguer un Ollama down
 * d'un Claude qui renvoie 200 + HTML.
 */
async function parseJsonResponse(res: Response, provider: string): Promise<any> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${provider} response body: ${msg}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new Error(`Failed to parse ${provider} response as JSON: ${snippet}`);
  }
}
