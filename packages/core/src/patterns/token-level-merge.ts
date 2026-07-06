import type { ClassifyInput, ConfidenceScore, PatternPlugin, TokenMergeTrace, TokenMergeLineDetail } from "../types.js";
import { makeScore, scopeImpact, tokenizeLine } from "./utils.js";

/** Cache module-level du dernier résultat calculé par detect(). */
let _lastResult: TokenMergeTrace | null = null;

/** Retourne le dernier résultat mis en cache par detect() (lu par classifier.ts et assemble.ts). */
export function getLastTokenMergeResult(): TokenMergeTrace | null {
  return _lastResult;
}

/**
 * Tente de résoudre une seule ligne en conflit (base/ours/theirs différents).
 * Retourne le detail de résolution si réussi, `null` si conflit réel ou tokens non alignés.
 */
function resolveConflictedLine(
  lineIndex: number,
  base: string,
  ours: string,
  theirs: string,
): TokenMergeLineDetail | null {
  const baseTokens = tokenizeLine(base);
  const oursTokens = tokenizeLine(ours);
  const theirsTokens = tokenizeLine(theirs);

  if (oursTokens.length !== baseTokens.length || theirsTokens.length !== baseTokens.length) {
    return null; // Pas de réalignement — hors périmètre v1.
  }

  const merged: string[] = [];
  const oursTokenIndices: number[] = [];
  const theirsTokenIndices: number[] = [];

  for (let j = 0; j < baseTokens.length; j++) {
    const oursChanged = oursTokens[j] !== baseTokens[j];
    const theirsChanged = theirsTokens[j] !== baseTokens[j];

    if (oursChanged && theirsChanged) {
      if (oursTokens[j] !== theirsTokens[j]) {
        return null; // Vrai conflit sur ce token — la ligne échoue.
      }
      merged.push(oursTokens[j]); // Même changement des deux côtés.
    } else if (oursChanged) {
      merged.push(oursTokens[j]);
      oursTokenIndices.push(j);
    } else if (theirsChanged) {
      merged.push(theirsTokens[j]);
      theirsTokenIndices.push(j);
    } else {
      merged.push(baseTokens[j]);
    }
  }

  return {
    lineIndex,
    resolvedBy: "pass2",
    resolvedLine: merged.join(""),
    oursTokenIndices,
    theirsTokenIndices,
  };
}

/**
 * Calcule la proposition complète de fusion pour le hunk, ou `null` si une
 * ligne au moins résiste (échec global — pas de résolution partielle).
 */
function computeTokenMerge(h: ClassifyInput): TokenMergeTrace | null {
  if (h.baseLines.length === 0) return null; // requires: diff3
  if (h.oursLines.length !== h.baseLines.length || h.theirsLines.length !== h.baseLines.length) {
    return null; // Pas d'alignement 1:1 possible.
  }

  const mergedLines: string[] = [];
  const lineDetails: TokenMergeLineDetail[] = [];
  let pass1Count = 0;
  let pass2Count = 0;

  for (let i = 0; i < h.baseLines.length; i++) {
    const base = h.baseLines[i];
    const ours = h.oursLines[i];
    const theirs = h.theirsLines[i];

    if (ours === base && theirs === base) {
      mergedLines.push(base); // Contexte pur.
      continue;
    }
    if (ours === base && theirs !== base) {
      mergedLines.push(theirs);
      lineDetails.push({ lineIndex: i, resolvedBy: "pass1", resolvedLine: theirs });
      pass1Count++;
      continue;
    }
    if (theirs === base && ours !== base) {
      mergedLines.push(ours);
      lineDetails.push({ lineIndex: i, resolvedBy: "pass1", resolvedLine: ours });
      pass1Count++;
      continue;
    }

    // Les deux côtés diffèrent de la base sur cette ligne — passe 2.
    const resolved = resolveConflictedLine(i, base, ours, theirs);
    if (resolved === null) return null; // Échec global.
    mergedLines.push(resolved.resolvedLine);
    lineDetails.push(resolved);
    pass2Count++;
  }

  if (pass2Count === 0 && pass1Count === 0) return null; // Rien à proposer.

  return { mergedLines, pass1Count, pass2Count, lineDetails };
}

const tokenLevelMerge: PatternPlugin = {
  type: "token_level_merge",
  priority: 65,
  requires: "diff3",

  detect(h: ClassifyInput): boolean {
    _lastResult = computeTokenMerge(h);
    return _lastResult !== null;
  },

  confidence(_h: ClassifyInput): ConfidenceScore {
    const totalLines = _lastResult ? _lastResult.mergedLines.length : 0;
    // dataRisk volontairement non-nul : ce pattern ne doit JAMAIS s'auto-appliquer,
    // quel que soit le score obtenu (cf. resolver/assemble.ts — case dédié).
    return makeScore(70, 38, scopeImpact(totalLines), [
      "Décomposition ligne-par-ligne et token-level réussie",
    ], [
      "Résolution proposée — jamais auto-appliquée, confirmation utilisateur requise",
    ]);
  },

  explanation(_h: ClassifyInput): string {
    if (!_lastResult) return "Fusion token-level proposée.";
    const { pass1Count, pass2Count } = _lastResult;
    return `Fusion proposée : ${pass1Count} ligne${pass1Count === 1 ? "" : "s"} résolue${pass1Count === 1 ? "" : "s"} ligne-par-ligne, ${pass2Count} ligne${pass2Count === 1 ? "" : "s"} fusionnée${pass2Count === 1 ? "" : "s"} token-par-token. Confirmation requise avant application.`;
  },

  passReason(_h: ClassifyInput): string {
    return "Décomposition ligne-par-ligne + diff token-level réussis sur toutes les lignes du hunk.";
  },

  failReason(_h: ClassifyInput): string {
    return "Au moins une ligne résiste (vrai conflit token-level ou désalignement de tokens) — pas de résolution partielle.";
  },
};

export default tokenLevelMerge;
