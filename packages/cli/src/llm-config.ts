/**
 * Résolution de la configuration LLM côté CLI.
 *
 * Pipeline :
 *  1. lire `.gitwandrc` (ou `.gitwandrc.json`) à la racine du repo Git courant,
 *  2. extraire la section `llmFallback` via `parseGitwandrc` (validation typée),
 *  3. merger avec les flags CLI — les flags CLI ont toujours priorité,
 *  4. retourner un `CliLlmConfig` prêt à passer à `buildLlmEndpoint()`.
 *
 * Le champ `endpoint` n'est jamais lu depuis le fichier (non sérialisable) ;
 * il est construit par `buildLlmEndpoint()` au moment de l'appel.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseGitwandrc,
  type GitWandrcConfig,
  type LlmFallbackConfig,
} from "@gitwand/core";

import {
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_TEMPERATURE,
  type CliLlmConfig,
  type CliLlmProvider,
} from "./llm-endpoint.js";

/** Modèles par défaut par provider (alignés sur les recommandations v2.5). */
const DEFAULT_MODELS: Record<CliLlmProvider, string> = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  ollama: "llama3",
};

/** Liste blanche des providers acceptés par le flag `--llm-provider`. */
export const VALID_PROVIDERS: CliLlmProvider[] = ["claude", "openai", "ollama"];

/**
 * Lit le fichier `.gitwandrc` (ou `.gitwandrc.json`) à la racine du repo
 * git courant et retourne sa config parsée. Retourne `null` si :
 *  - on n'est pas dans un repo git,
 *  - le fichier n'existe pas,
 *  - le contenu est invalide (`parseGitwandrc` renvoie null).
 *
 * Tolérant : ne throw jamais — un fichier illisible ne doit pas faire crasher
 * le CLI. L'utilisateur peut toujours passer la config via les flags.
 */
export function loadGitwandrcLlmConfig(): GitWandrcConfig["llmFallback"] | null {
  const repoRoot = findGitRoot();
  if (repoRoot === null) return null;

  for (const filename of [".gitwandrc", ".gitwandrc.json"]) {
    const path = join(repoRoot, filename);
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseGitwandrc(content);
    if (parsed === null) continue;
    return parsed.llmFallback ?? null;
  }
  return null;
}

/**
 * Localise la racine du repo git courant via `git rev-parse --show-toplevel`.
 * Retourne `null` si on n'est pas dans un repo ou si git est introuvable —
 * dans ce cas le CLI utilisera uniquement les flags + l'environnement.
 */
function findGitRoot(): string | null {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Merge `.gitwandrc.llmFallback` (s'il existe) avec les flags CLI.
 *
 * Priorité des sources (de la plus faible à la plus forte) :
 *   defaults < `.gitwandrc` < flags CLI
 *
 * Retourne `{ config, fileConfig }` :
 *  - `config` : `CliLlmConfig` complet, prêt pour `buildLlmEndpoint()`,
 *  - `fileConfig` : la section `.gitwandrc.llmFallback` brute (utile pour
 *    propager `minPostMergeScore`, `contextLines`, `minMode` à `resolveAsync`).
 */
export function resolveLlmConfig(
  flags: Record<string, boolean | string>,
): { config: CliLlmConfig; fileConfig: GitWandrcConfig["llmFallback"] | null } {
  const fileConfig = loadGitwandrcLlmConfig();

  const flagProvider = typeof flags["llm-provider"] === "string"
    ? (flags["llm-provider"] as string)
    : undefined;
  const provider: CliLlmProvider = (() => {
    if (flagProvider !== undefined) {
      if (!(VALID_PROVIDERS as string[]).includes(flagProvider)) {
        throw new Error(
          `Invalid --llm-provider "${flagProvider}". Expected one of: ${VALID_PROVIDERS.join(", ")}`,
        );
      }
      return flagProvider as CliLlmProvider;
    }
    return "claude";
  })();

  const flagModel = typeof flags["llm-model"] === "string" ? (flags["llm-model"] as string) : undefined;
  const model = flagModel ?? fileConfig?.model ?? DEFAULT_MODELS[provider];

  const maxTokens = fileConfig?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS;
  const temperature = fileConfig?.temperature ?? DEFAULT_LLM_TEMPERATURE;

  // Ollama : permet override URL via env OLLAMA_URL (déjà géré dans llm-endpoint).
  const config: CliLlmConfig = {
    provider,
    model,
    maxTokens,
    temperature,
  };

  return { config, fileConfig };
}

/**
 * Construit le bloc `llmFallback` à passer à `resolveAsync()`, en partant de
 * la config fichier (pour `minPostMergeScore`, `contextLines`, `minMode`) et
 * en y attachant les champs essentiels (`enabled: true`, `model`, `maxTokens`,
 * `temperature`).
 *
 * L'`endpoint` lui-même n'est PAS ajouté ici — le caller le branche après
 * via `buildLlmEndpoint(config)`.
 */
export function buildResolveLlmOptions(
  cliConfig: CliLlmConfig,
  fileConfig: GitWandrcConfig["llmFallback"] | null,
): Omit<LlmFallbackConfig, "endpoint"> {
  const out: Omit<LlmFallbackConfig, "endpoint"> = {
    enabled: true,
    model: cliConfig.model,
    maxTokens: cliConfig.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    temperature: cliConfig.temperature ?? DEFAULT_LLM_TEMPERATURE,
  };

  if (fileConfig?.contextLines !== undefined) out.contextLines = fileConfig.contextLines;
  if (fileConfig?.minPostMergeScore !== undefined) out.minPostMergeScore = fileConfig.minPostMergeScore;
  if (fileConfig?.minMode !== undefined) out.minMode = fileConfig.minMode;

  return out;
}
