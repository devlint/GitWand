import type { ClassifyInput, ConfidenceScore, PatternPlugin, TokenMergeTrace, TokenMergeLineDetail } from "../types.js";
import { makeScore, scopeImpact, tokenizeLine } from "./utils.js";

/**
 * Cache module-level, keyed par référence sur le dernier hunk calculé.
 *
 * `detect()`, `confidence()` et `explanation()` reçoivent tous le même hunk
 * dans le flux normal (classifier.ts appelle les trois coup sur coup sur la
 * même référence `ClassifyInput`), donc le cache est un hit à chaque fois en
 * pratique. Mais contrairement à un simple "dernier résultat calculé" (qui
 * suppose implicitement qu'aucun autre appel à detect() ne s'intercale entre
 * temps sur un hunk différent), la clé sur la référence rend le cache
 * auto-correcteur : un hunk différent en entrée déclenche un recalcul au lieu
 * de retourner silencieusement le résultat d'un autre hunk.
 */
let _lastInput: ClassifyInput | null = null;
let _lastResult: TokenMergeTrace | null = null;

function computeTokenMergeCached(h: ClassifyInput): TokenMergeTrace | null {
  if (_lastInput === h) return _lastResult;
  _lastInput = h;
  _lastResult = computeTokenMerge(h);
  return _lastResult;
}

/** Retourne le dernier résultat mis en cache (lu par classifier.ts pour peupler `trace.tokenMergeTrace`). */
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
    return computeTokenMergeCached(h) !== null;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const result = computeTokenMergeCached(h);
    const totalLines = result ? result.mergedLines.length : 0;
    // dataRisk volontairement non-nul : ce pattern ne doit JAMAIS s'auto-appliquer,
    // quel que soit le score obtenu (cf. resolver/assemble.ts — case dédié).
    return makeScore(70, 38, scopeImpact(totalLines), [
      "Line-by-line and token-level decomposition succeeded",
    ], [
      "Resolution proposed: never auto-applied, user confirmation required",
    ]);
  },

  explanation(h: ClassifyInput): string {
    const result = computeTokenMergeCached(h);
    if (!result) return "Token-level merge proposed.";
    const { pass1Count, pass2Count } = result;
    return `Merge proposed: ${pass1Count} line${pass1Count === 1 ? "" : "s"} resolved line-by-line, ${pass2Count} line${pass2Count === 1 ? "" : "s"} merged token-by-token. Confirmation required before it is applied.`;
  },

  passReason(_h: ClassifyInput): string {
    return "Line-by-line decomposition and token-level diff succeeded on every line of the hunk.";
  },

  failReason(_h: ClassifyInput): string {
    return "At least one line resists (a real token-level conflict, or misaligned tokens), and partial resolutions are not offered.";
  },
};

export default tokenLevelMerge;
