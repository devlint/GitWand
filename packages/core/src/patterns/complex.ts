import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { makeScore } from "./utils.js";

/** Fallback — s'applique toujours, placé en fin de registre */
const complex: PatternPlugin = {
  type: "complex",
  priority: 999,
  requires: "both",

  detect(_h: ClassifyInput): boolean {
    return true; // always matches — unreachable guard
  },

  confidence(_h: ClassifyInput): ConfidenceScore {
    return makeScore(100, 100, 0, [], [
      "Aucune heuristique automatique applicable",
      "Les deux branches ont modifié le bloc de façon incompatible",
    ]);
  },

  explanation(_h: ClassifyInput): string {
    return "Conflit complexe nécessitant une résolution manuelle. Les deux branches ont modifié ce bloc différemment.";
  },

  passReason(_h: ClassifyInput): string {
    return "Aucun pattern automatique ne s'applique — résolution manuelle requise.";
  },

  failReason(_h: ClassifyInput): string {
    return ""; // ne peut pas échouer
  },
};

export default complex;
