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
      "Both branches have exactly the same content",
    ], []);
  },

  explanation(_h: ClassifyInput): string {
    return "Both branches made exactly the same edit.";
  },

  passReason(_h: ClassifyInput): string {
    return "Both branches have exactly the same content: an identical edit on each side.";
  },

  failReason(_h: ClassifyInput): string {
    return "The branches have different content.";
  },
};

export default sameChange;
