import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { scopeImpact, makeScore, normalizeForWhitespaceCheck } from "./utils.js";

const whitespaceOnly: PatternPlugin = {
  type: "whitespace_only",
  priority: 50,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    const oursNorm = normalizeForWhitespaceCheck(h.oursLines);
    const theirsNorm = normalizeForWhitespaceCheck(h.theirsLines);
    return oursNorm === theirsNorm;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const hasBase = h.baseLines.length > 0;
    const lines = Math.max(h.oursLines.length, h.theirsLines.length);
    return makeScore(
      hasBase ? 95 : 80,
      10,
      scopeImpact(lines),
      hasBase
        ? [
            "Base disponible — whitespace confirmé par rapport à l'ancêtre",
            "Seul le whitespace diffère après normalisation",
          ]
        : ["Seul le whitespace diffère après normalisation (trim)"],
      hasBase ? [] : ["Sans base (diff2) — hypothèse basée sur la normalisation uniquement"],
    );
  },

  explanation(_h: ClassifyInput): string {
    return "Les deux branches contiennent le même code avec des différences de whitespace uniquement.";
  },

  passReason(_h: ClassifyInput): string {
    return "Après normalisation (trim), les deux versions sont identiques — seul le whitespace diffère.";
  },

  failReason(_h: ClassifyInput): string {
    return "Après normalisation (trim), les deux versions restent différentes — pas seulement du whitespace.";
  },
};

export default whitespaceOnly;
