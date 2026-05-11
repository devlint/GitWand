/**
 * Rapport JSON pour le mode CI.
 *
 * Ce module expose le type `CIReport` (contrat public du `--ci` / `--json`)
 * et la fonction `buildCIReport` qui projette un tableau de `MergeResult`
 * en cette structure stable.
 *
 * La forme du JSON est considérée comme un contrat avec les CI existantes
 * des utilisateurs — toute évolution doit être versionnée via le champ
 * `version`.
 */

import type { LlmTrace, MergeResult } from "@gitwand/core";

/** Forme stable du rapport JSON émis par `gitwand resolve --ci`. */
export interface CIReport {
  version: string;
  timestamp: string;
  summary: {
    files: number;
    totalConflicts: number;
    autoResolved: number;
    remaining: number;
    allResolved: boolean;
  };
  files: Array<{
    path: string;
    totalConflicts: number;
    autoResolved: number;
    remaining: number;
    validation: {
      isValid: boolean;
      hasResidualMarkers: boolean;
      syntaxError: string | null;
    };
    resolutions: Array<{
      line: number;
      type: string;
      resolved: boolean;
      explanation: string;
      confidence: {
        overall: number;
        typeClassification: number;
        dataRisk: number;
        scopeImpact: number;
      };
      trace: {
        selected: string;
        hasBase: boolean;
        summary: string;
        steps: Array<{
          type: string;
          passed: boolean;
          reason: string;
        }>;
      };
      /**
       * v2.5 — Trace LLM, présente uniquement quand `type === "llm_proposed"`.
       * Audit trail intégral : modèle, latence, hash prompt, score validation.
       */
      llmTrace?: LlmTrace;
    }>;
    pendingHunks: Array<{
      line: number;
      type: string;
      explanation: string;
      ours: string;
      theirs: string;
      base: string;
      confidence: {
        overall: number;
        typeClassification: number;
        dataRisk: number;
        scopeImpact: number;
      };
      trace: {
        selected: string;
        hasBase: boolean;
        summary: string;
        steps: Array<{
          type: string;
          passed: boolean;
          reason: string;
        }>;
      };
    }>;
  }>;
}

/**
 * Projette une liste de résultats de merge en un `CIReport`.
 *
 * @param results — paires `{ file, result }` dans l'ordre d'affichage.
 *                  Les fichiers non trouvés doivent être exclus en amont.
 */
export function buildCIReport(
  results: Array<{ file: string; result: MergeResult }>,
): CIReport {
  let totalConflicts = 0;
  let totalResolved = 0;

  const files = results.map(({ file, result }) => {
    totalConflicts += result.stats.totalConflicts;
    totalResolved += result.stats.autoResolved;

    return {
      path: file,
      totalConflicts: result.stats.totalConflicts,
      autoResolved: result.stats.autoResolved,
      remaining: result.stats.remaining,
      validation: {
        isValid: result.validation.isValid,
        hasResidualMarkers: result.validation.hasResidualMarkers,
        syntaxError: result.validation.syntaxError,
      },
      resolutions: result.resolutions.map((r) => ({
        line: r.hunk.startLine,
        type: r.hunk.type,
        resolved: r.autoResolved,
        explanation: r.hunk.explanation,
        confidence: {
          overall: r.hunk.confidence.score,
          typeClassification: r.hunk.confidence.dimensions.typeClassification,
          dataRisk: r.hunk.confidence.dimensions.dataRisk,
          scopeImpact: r.hunk.confidence.dimensions.scopeImpact,
        },
        trace: {
          selected: r.hunk.trace.selected,
          hasBase: r.hunk.trace.hasBase,
          summary: r.hunk.trace.summary,
          steps: r.hunk.trace.steps.map((s) => ({
            type: s.type,
            passed: s.passed,
            reason: s.reason,
          })),
        },
        // v2.5 — clé optionnelle, présente uniquement pour les hunks `llm_proposed`.
        ...(r.hunk.trace.llmTrace ? { llmTrace: r.hunk.trace.llmTrace } : {}),
      })),
      pendingHunks: result.resolutions
        .filter((r) => !r.autoResolved)
        .map((r) => ({
          line: r.hunk.startLine,
          type: r.hunk.type,
          explanation: r.hunk.explanation,
          ours: r.hunk.oursLines.join("\n"),
          theirs: r.hunk.theirsLines.join("\n"),
          base: r.hunk.baseLines.join("\n"),
          confidence: {
            overall: r.hunk.confidence.score,
            typeClassification: r.hunk.confidence.dimensions.typeClassification,
            dataRisk: r.hunk.confidence.dimensions.dataRisk,
            scopeImpact: r.hunk.confidence.dimensions.scopeImpact,
          },
          trace: {
            selected: r.hunk.trace.selected,
            hasBase: r.hunk.trace.hasBase,
            summary: r.hunk.trace.summary,
            steps: r.hunk.trace.steps.map((s) => ({
              type: s.type,
              passed: s.passed,
              reason: s.reason,
            })),
          },
        })),
    };
  });

  return {
    version: "0.0.1",
    timestamp: new Date().toISOString(),
    summary: {
      files: results.length,
      totalConflicts,
      autoResolved: totalResolved,
      remaining: totalConflicts - totalResolved,
      allResolved: totalConflicts - totalResolved === 0,
    },
    files,
  };
}
