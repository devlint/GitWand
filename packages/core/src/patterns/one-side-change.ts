import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { scopeImpact, makeScore } from "./utils.js";

const oneSideChange: PatternPlugin = {
  type: "one_side_change",
  priority: 30,
  requires: "diff3",

  detect(h: ClassifyInput): boolean {
    const baseText = h.baseLines.join("\n");
    const oursText = h.oursLines.join("\n");
    const theirsText = h.theirsLines.join("\n");
    const oursMatchesBase = oursText === baseText;
    const theirsMatchesBase = theirsText === baseText;
    return (oursMatchesBase && !theirsMatchesBase) || (!oursMatchesBase && theirsMatchesBase);
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const baseText = h.baseLines.join("\n");
    const oursText = h.oursLines.join("\n");
    const oursMatchesBase = oursText === baseText;
    const changedLines = oursMatchesBase ? h.theirsLines.length : h.oursLines.length;
    return makeScore(100, 0, scopeImpact(changedLines), [
      "Base disponible",
      oursMatchesBase ? "Only theirs modified the block" : "Only ours modified the block",
    ], []);
  },

  explanation(h: ClassifyInput): string {
    const oursText = h.oursLines.join("\n");
    const baseText = h.baseLines.join("\n");
    if (oursText === baseText) {
      return "Only the incoming branch (theirs) modified this block. Resolution: take theirs.";
    }
    return "Only the current branch (ours) modified this block. Resolution: take ours.";
  },

  passReason(h: ClassifyInput): string {
    const oursText = h.oursLines.join("\n");
    const baseText = h.baseLines.join("\n");
    if (oursText === baseText) {
      return "Ours is identical to the base; only theirs changed.";
    }
    return "Theirs is identical to the base; only ours changed.";
  },

  failReason(_h: ClassifyInput): string {
    return "Both branches modified the block relative to the base.";
  },
};

export default oneSideChange;
