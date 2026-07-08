import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { makeScore, detectValueOnlyChange } from "./utils.js";

const valueOnlyChange: PatternPlugin = {
  type: "value_only_change",
  priority: 60,
  // "both" depuis v2.7 : avec base (diff3), un changement unilatéral est déjà
  // pris par one_side_change (prio 30) — ce pattern ne voit donc que les cas
  // où LES DEUX côtés ont changé la valeur. En "diff2" il était inatteignable
  // dès que la base recovery du desktop enrichissait le conflit.
  requires: "both",

  detect(h: ClassifyInput): boolean {
    if (h.oursLines.length !== h.theirsLines.length) return false;
    return detectValueOnlyChange(h.oursLines, h.theirsLines, h.baseLines.length > 0) !== null;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const result = detectValueOnlyChange(h.oursLines, h.theirsLines, h.baseLines.length > 0);
    if (result) return result.confidenceScore;
    // Fallback (ne devrait pas être appelé si detect() retourne false)
    return makeScore(0, 100, 0, [], ["Erreur interne : confidence() appelé sans match"]);
  },

  explanation(h: ClassifyInput): string {
    const result = detectValueOnlyChange(h.oursLines, h.theirsLines, h.baseLines.length > 0);
    return result?.explanation ?? "Valeurs volatiles différentes.";
  },

  passReason(h: ClassifyInput): string {
    const result = detectValueOnlyChange(h.oursLines, h.theirsLines, h.baseLines.length > 0);
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
