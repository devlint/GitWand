import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import type { ExplanationRef } from "../explanation-keys.js";
import { makeScore, detectValueOnlyChange } from "./utils.js";

/**
 * `detect`, `confidence`, `explanation`, `explanationRef` and `passReason` are
 * called one after the other on the same hunk: the detection runs once per
 * hunk content.
 */
let _lastKey: string | null = null;
let _lastResult: ReturnType<typeof detectValueOnlyChange> = null;

/** Forgets the cached detection (called at the start of each classification). */
export function resetValueOnlyCache(): void {
  _lastKey = null;
  _lastResult = null;
}

function detectCached(h: ClassifyInput): ReturnType<typeof detectValueOnlyChange> {
  // Keyed on the lines' contents (unambiguously: JSON keeps line bounds), so
  // an input edited in place gets a fresh detection. Cheap next to the token
  // comparison it saves.
  const key = JSON.stringify([h.baseLines.length > 0, h.oursLines, h.theirsLines]);
  if (key !== _lastKey) {
    _lastKey = key;
    _lastResult = detectValueOnlyChange(h.oursLines, h.theirsLines, h.baseLines.length > 0);
  }
  return _lastResult;
}

const valueOnlyChange: PatternPlugin = {
  type: "value_only_change",
  priority: 60,
  // "both" depuis v3.4 : avec base (diff3), un changement unilatéral est déjà
  // pris par one_side_change (prio 30) — ce pattern ne voit donc que les cas
  // où LES DEUX côtés ont changé la valeur. En "diff2" il était inatteignable
  // dès que la base recovery du desktop enrichissait le conflit.
  requires: "both",

  detect(h: ClassifyInput): boolean {
    if (h.oursLines.length !== h.theirsLines.length) return false;
    return detectCached(h) !== null;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const result = detectCached(h);
    if (result) return result.confidenceScore;
    // Fallback (ne devrait pas être appelé si detect() retourne false)
    return makeScore(0, 100, 0, [], ["Internal error: confidence() called without a match"]);
  },

  explanation(h: ClassifyInput): string {
    const result = detectCached(h);
    return result?.explanation ?? "Differing volatile values.";
  },
  explanationRef(h: ClassifyInput): ExplanationRef {
    const result = detectCached(h);
    return result ? { key: "valueOnly", params: [result.diffCount] } : { key: "valueOnlyFallback" };
  },

  passReason(h: ClassifyInput): string {
    const result = detectCached(h);
    return result?.traceReason ?? "Atomic values identified as volatile.";
  },

  failReason(h: ClassifyInput): string {
    if (h.oursLines.length !== h.theirsLines.length) {
      return "Ours and theirs do not have the same number of lines, so the structure differs.";
    }
    return "The differences between ours and theirs go beyond volatile values (hash, version, timestamp…).";
  },
};

export default valueOnlyChange;
