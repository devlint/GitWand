import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { mergeNonOverlapping } from "../diff.js";
import { scopeImpact, makeScore } from "./utils.js";

const nonOverlapping: PatternPlugin = {
  type: "non_overlapping",
  priority: 40,
  requires: "diff3",

  detect(h: ClassifyInput): boolean {
    return mergeNonOverlapping(h.baseLines, h.oursLines, h.theirsLines) !== null;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const mergedSize = Math.max(h.oursLines.length, h.theirsLines.length);
    return makeScore(90, 20, scopeImpact(mergedSize), [
      "Base disponible",
      "Merge LCS 3-way réussi sans chevauchement",
    ], []);
  },

  explanation(_h: ClassifyInput): string {
    return "Les deux branches ont modifié des zones différentes du même bloc. Fusion automatique possible.";
  },

  passReason(_h: ClassifyInput): string {
    return "Le merge 3-way LCS a réussi sans conflit — les modifications ne se chevauchent pas.";
  },

  failReason(_h: ClassifyInput): string {
    return "Le merge 3-way LCS détecte un chevauchement — les deux branches ont modifié les mêmes lignes.";
  },
};

export default nonOverlapping;
