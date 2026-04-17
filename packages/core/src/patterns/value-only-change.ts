import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { makeScore, detectValueOnlyChange } from "./utils.js";

const valueOnlyChange: PatternPlugin = {
  type: "value_only_change",
  priority: 60,
  requires: "diff2",

  detect(h: ClassifyInput): boolean {
    if (h.oursLines.length !== h.theirsLines.length) return false;
    return detectValueOnlyChange(h.oursLines, h.theirsLines) !== null;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const result = detectValueOnlyChange(h.oursLines, h.theirsLines);
    if (result) return result.confidenceScore;
    // Fallback (ne devrait pas être appelé si detect() retourne false)
    return makeScore(0, 100, 0, [], ["Erreur interne : confidence() appelé sans match"]);
  },

  explanation(h: ClassifyInput): string {
    const result = detectValueOnlyChange(h.oursLines, h.theirsLines);
    return result?.explanation ?? "Valeurs volatiles différentes.";
  },

  passReason(h: ClassifyInput): string {
    const result = detectValueOnlyChange(h.oursLines, h.theirsLines);
    return result?.traceReason ?? "Valeurs atomiques identifiées comme volatiles.";
  },

  failReason(h: ClassifyInput): string {
    if (h.oursLines.length !== h.theirsLines.length) {
      return "Ours et theirs n'ont pas le même nombre de lignes — structure différente.";
    }
    return "Les différences entre ours et theirs ne se limitent pas à des valeurs volatiles (hash, version, timestamp…).";
  },
};

export default valueOnlyChange;
