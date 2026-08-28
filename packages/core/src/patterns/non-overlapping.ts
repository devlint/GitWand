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
      "3-way LCS merge succeeded with no overlap",
    ], []);
  },

  explanation(_h: ClassifyInput): string {
    return "The branches modified different regions of the same block, so an automatic merge is possible.";
  },

  passReason(_h: ClassifyInput): string {
    return "The 3-way LCS merge succeeded with no conflict: the edits do not overlap.";
  },

  failReason(_h: ClassifyInput): string {
    return "The 3-way LCS merge detects an overlap: both branches modified the same lines.";
  },
};

export default nonOverlapping;
