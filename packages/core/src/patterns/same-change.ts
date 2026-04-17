import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { scopeImpact, makeScore } from "./utils.js";

const sameChange: PatternPlugin = {
  type: "same_change",
  priority: 10,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    return h.oursLines.join("\n") === h.theirsLines.join("\n");
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    return makeScore(100, 0, scopeImpact(h.oursLines.length), [
      "Les deux branches ont exactement le même contenu",
    ], []);
  },

  explanation(_h: ClassifyInput): string {
    return "Les deux branches ont effectué exactement la même modification.";
  },

  passReason(_h: ClassifyInput): string {
    return "Les deux branches ont exactement le même contenu — modification identique des deux côtés.";
  },

  failReason(_h: ClassifyInput): string {
    return "Les deux branches ont des contenus différents.";
  },
};

export default sameChange;
