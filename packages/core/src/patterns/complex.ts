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
      "No automatic heuristic applies",
      "Both branches modified the block in incompatible ways",
    ]);
  },

  explanation(_h: ClassifyInput): string {
    return "A genuine conflict that needs a human. Both branches modified this block differently.";
  },

  passReason(_h: ClassifyInput): string {
    return "No automatic pattern applies; manual resolution required.";
  },

  failReason(_h: ClassifyInput): string {
    return ""; // ne peut pas échouer
  },
};

export default complex;
