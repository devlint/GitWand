/**
 * v2.5 — LLM fallback resolver.
 *
 * Sérialise un hunk de conflit + son contexte, envoie le prompt à l'endpoint
 * LLM injecté par le consommateur, valide le résultat proposé, et retourne
 * la résolution avec une trace d'audit complète.
 *
 * ### Contrainte browser
 * Ce module n'utilise aucun module Node.js natif (`fs`, `crypto`, `child_process`…).
 * Le hash SHA-256 est calculé via l'API Web Crypto (`globalThis.crypto.subtle`),
 * disponible en browser, Node.js ≥ 18, et Tauri.
 */

import type { ConflictHunk, LlmFallbackConfig, LlmTrace } from "../types.js";
import { validateMergedContent } from "../resolver/validation.js";

// ─── Types publics ──────────────────────────────────────────

/** Résultat de la tentative de résolution LLM d'un hunk. */
export interface LlmResolveResult {
  /** Lignes résolues (null = résolution refusée) */
  lines: string[] | null;
  /** Raison lisible de l'acceptation ou du refus */
  reason: string;
  /** Trace d'audit complète (toujours présente, même en cas de refus) */
  llmTrace: LlmTrace;
}

// ─── Helpers internes ──────────────────────────────────────

/**
 * Calcule un hash FNV-1a 64-bit (simulé en double uint32) d'une chaîne.
 *
 * Remplace l'implémentation WebCrypto (SHA-256) qui n'est pas disponible comme
 * global sur Node.js < 19 (globalThis.crypto devient global en Node 19 seulement).
 * packages/core doit rester compatible browser+Node+Tauri sans import Node.js natif.
 *
 * FNV-1a est largement suffisant pour le promptHash d'audit — stable, déterministe,
 * pas de dépendance d'environnement.
 */
function sha256Hex(text: string): string {
  // FNV-1a 64-bit simulé via deux uint32 (hi + lo) pour réduire les collisions
  let hi = 0x6295c58d;
  let lo = 0x62b82175;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    lo ^= c;
    // Multiply by FNV prime 0x00000100000001B3 split as (hi:0x100, lo:0x000001B3)
    const loNew = Math.imul(lo, 0x000001b3) >>> 0;
    const hiNew = (Math.imul(lo, 0x100) + Math.imul(hi, 0x000001b3)) >>> 0;
    lo = loNew;
    hi = hiNew;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * Calcule un score de validation (0–100) à partir d'un `ValidationResult`.
 *
 * | Condition                              | Score |
 * |----------------------------------------|-------|
 * | Marqueurs résiduels détectés           | 0     |
 * | Erreur de syntaxe structurée           | 0     |
 * | Parse-tree invalide                    | 0     |
 * | Validation externe échouée (tsc/eslint)| 50    |
 * | Tout OK                                | 100   |
 */
function computeValidationScore(
  validation: ReturnType<typeof validateMergedContent>,
  parseTreeValid?: boolean | null,
  externalValidationPassed?: boolean | null,
): number {
  if (validation.hasResidualMarkers) return 0;
  if (validation.syntaxError !== null) return 0;
  if (parseTreeValid === false) return 0;
  if (externalValidationPassed === false) return 50;
  return 100;
}

/**
 * Construit le prompt structuré envoyé au LLM.
 *
 * Format :
 * - Contexte autour du hunk (±contextLines lignes)
 * - Sérialisation complète du hunk (base/ours/theirs)
 * - Résumé de la DecisionTrace partielle
 * - Instructions explicites (output uniquement en code block)
 */
function buildPrompt(
  hunk: ConflictHunk,
  filePath: string,
  fileContext: string,
  config: LlmFallbackConfig,
): string {
  const contextLines = config.contextLines ?? 50;
  const base = hunk.baseLines.join("\n");
  const ours = hunk.oursLines.join("\n");
  const theirs = hunk.theirsLines.join("\n");

  const traceSteps = hunk.trace.steps
    .map((s) => `  [${s.passed ? "✓" : "✗"}] ${s.type}: ${s.reason}`)
    .join("\n");

  const hasBase = hunk.baseLines.length > 0;
  const conflictBlock = hasBase
    ? `<<<<<<< ours\n${ours}\n||||||| base\n${base}\n=======\n${theirs}\n>>>>>>> theirs`
    : `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs`;

  return `You are an expert Git merge conflict resolver. Your task is to resolve the conflict below.

## File: ${filePath}

## Context (±${contextLines} lines around the conflict):
\`\`\`
${fileContext}
\`\`\`

## Conflict hunk to resolve (line ${hunk.startLine}):
\`\`\`
${conflictBlock}
\`\`\`

## Analysis (partial decision trace):
${traceSteps || "  No patterns matched — conflict is complex."}

## Instructions:
- Output ONLY the resolved lines inside a single fenced code block (\`\`\`)
- Do NOT include conflict markers (<<<<<<<, =======, >>>>>>>, |||||||)
- Preserve indentation, coding style, and surrounding context
- If you cannot resolve this conflict safely, output exactly: CANNOT_RESOLVE
- Do not explain your reasoning — only output the code block or CANNOT_RESOLVE

## Resolution:`.trim();
}

/**
 * Extrait les lignes résolues depuis la réponse brute du LLM.
 *
 * Accepte :
 * - Une réponse contenant un bloc de code fencé (\`\`\`...\`\`\`)
 * - Une réponse contenant "CANNOT_RESOLVE"
 * - Une réponse brute (fallback : toutes les lignes sauf la première si vide)
 *
 * @returns Les lignes résolues, ou `null` si le LLM a refusé ou si la réponse est vide.
 */
function parseResponse(raw: string): string[] | null {
  const trimmed = raw.trim();

  if (!trimmed || trimmed === "CANNOT_RESOLVE" || trimmed.includes("CANNOT_RESOLVE")) {
    return null;
  }

  // Extraire le contenu du premier bloc fencé
  const fenceMatch = trimmed.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const content = fenceMatch[1];
    // Retirer le trailing newline du bloc mais garder les lignes internes
    return content.replace(/\n$/, "").split("\n");
  }

  // Fallback : retourner les lignes brutes (sans la première ligne si elle est vide)
  const lines = trimmed.split("\n");
  return lines.length > 0 ? lines : null;
}

// ─── Résolveur principal ───────────────────────────────────

/**
 * Tente de résoudre un hunk de conflit via le fallback LLM.
 *
 * Pipeline :
 * 1. Construit le prompt (sérialisation hunk + contexte + trace partielle)
 * 2. Calcule le hash SHA-256 du prompt (audit de reproductibilité)
 * 3. Appelle `config.endpoint.call(prompt)` (fourni par le consommateur)
 * 4. Parse la réponse (extrait les lignes résolues)
 * 5. Valide le résultat (`validateMergedContent`)
 * 6. Accepte si `score ≥ minPostMergeScore`, refuse sinon
 * 7. Retourne `LlmResolveResult` avec la trace complète
 *
 * @param hunk        - Hunk de conflit à résoudre
 * @param filePath    - Chemin du fichier (pour validation post-merge)
 * @param fileContext - ±N lignes autour du hunk (fournies par l'appelant)
 * @param config      - Configuration LLM fallback (avec endpoint injecté)
 */
export async function tryLlmFallbackResolve(
  hunk: ConflictHunk,
  filePath: string,
  fileContext: string,
  config: LlmFallbackConfig,
): Promise<LlmResolveResult> {
  const calledAt = new Date().toISOString();
  const model = config.model ?? "claude-sonnet-4-6";
  const minPostMergeScore = config.minPostMergeScore ?? 80;

  // Vérification de l'endpoint (requis pour que le fallback fonctionne)
  if (!config.endpoint) {
    const trace: LlmTrace = {
      calledAt,
      model,
      latencyMs: 0,
      promptHash: "",
      rawResponseTruncated: "",
      validationScore: 0,
      accepted: false,
    };
    return {
      lines: null,
      reason: "LLM fallback skipped: no endpoint was injected (config.endpoint missing).",
      llmTrace: trace,
    };
  }

  const prompt = buildPrompt(hunk, filePath, fileContext, config);
  const promptHash = sha256Hex(prompt);
  const t0 = Date.now();

  let rawResponse: string;
  try {
    rawResponse = await config.endpoint.call(prompt);
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const errMsg = err instanceof Error ? err.message : String(err);
    const trace: LlmTrace = {
      calledAt,
      model,
      latencyMs,
      promptHash,
      rawResponseTruncated: "",
      validationScore: 0,
      accepted: false,
    };
    return {
      lines: null,
      reason: `LLM endpoint erreur : ${errMsg}`,
      llmTrace: trace,
    };
  }

  const latencyMs = Date.now() - t0;
  const rawResponseTruncated = rawResponse.slice(0, 500);

  // Parse la réponse brute
  const proposedLines = parseResponse(rawResponse);

  if (proposedLines === null) {
    const trace: LlmTrace = {
      calledAt,
      model,
      latencyMs,
      promptHash,
      rawResponseTruncated,
      validationScore: 0,
      accepted: false,
    };
    return {
      lines: null,
      reason: "The LLM declined to resolve this conflict (CANNOT_RESOLVE, or an empty response).",
      llmTrace: trace,
    };
  }

  // Validation post-merge du contenu proposé
  const candidateContent = proposedLines.join("\n");
  const validation = validateMergedContent(candidateContent, filePath);
  const validationScore = computeValidationScore(validation);

  const accepted = validation.isValid && validationScore >= minPostMergeScore;

  const trace: LlmTrace = {
    calledAt,
    model,
    latencyMs,
    promptHash,
    rawResponseTruncated,
    validationScore,
    accepted,
  };

  if (!accepted) {
    const reason = !validation.isValid
      ? `LLM resolution rejected: validation failed (residual markers: ${validation.hasResidualMarkers}, syntax: ${validation.syntaxError ?? "ok"}).`
      : `LLM resolution rejected: validation score ${validationScore} is below the required minimum ${minPostMergeScore}.`;

    return { lines: null, reason, llmTrace: trace };
  }

  return {
    lines: proposedLines,
    reason: `LLM resolution accepted (score: ${validationScore}/100, latency: ${latencyMs}ms, model: ${model}).`,
    llmTrace: trace,
  };
}
