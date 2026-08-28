import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { makeScore } from "./utils.js";

const deleteNoChange: PatternPlugin = {
  type: "delete_no_change",
  priority: 20,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      const baseText = h.baseLines.join("\n");
      const oursText = h.oursLines.join("\n");
      const theirsText = h.theirsLines.join("\n");
      return (
        (h.oursLines.length === 0 && theirsText === baseText) ||
        (h.theirsLines.length === 0 && oursText === baseText)
      );
    }
    // diff2 fallback
    return (
      (h.oursLines.length === 0 && h.theirsLines.length > 0) ||
      (h.theirsLines.length === 0 && h.oursLines.length > 0)
    );
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      const baseText = h.baseLines.join("\n");
      const theirsText = h.theirsLines.join("\n");
      const oursDeleted = h.oursLines.length === 0 && theirsText === baseText;
      return makeScore(100, 5, 0, [
        "Base disponible",
        oursDeleted
          ? "Ours deleted, theirs identical to the base"
          : "Theirs deleted, ours identical to the base",
      ], []);
    }
    return makeScore(60, 30, 0, [], [
      "No base (diff2): the deletion is not confirmed against the common ancestor",
    ]);
  },

  explanation(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      const baseText = h.baseLines.join("\n");
      const theirsText = h.theirsLines.join("\n");
      if (h.oursLines.length === 0 && theirsText === baseText) {
        return "The current branch (ours) deleted this block and the other left it untouched. Resolution: delete.";
      }
      return "The incoming branch (theirs) deleted this block and the other left it untouched. Resolution: delete.";
    }
    if (h.oursLines.length === 0) {
      return "The current branch (ours) deleted this block. Without a base, confidence is medium. Proposed resolution: delete.";
    }
    return "The incoming branch (theirs) deleted this block. Without a base, confidence is medium. Proposed resolution: delete.";
  },

  passReason(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      const baseText = h.baseLines.join("\n");
      const theirsText = h.theirsLines.join("\n");
      if (h.oursLines.length === 0 && theirsText === baseText) {
        return "Ours deleted the block (0 lines) and theirs did not modify the base.";
      }
      return "Theirs deleted the block (0 lines) and ours did not modify the base.";
    }
    if (h.oursLines.length === 0) {
      return "Ours is empty (0 lines) in diff2. A deletion is likely but uncertain without a base.";
    }
    return "Theirs is empty (0 lines) in diff2. A deletion is likely but uncertain without a base.";
  },

  failReason(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      return "Neither ours nor theirs is a one-sided deletion with the other side identical to the base.";
    }
    return "Neither ours nor theirs is empty in diff2, so there is no obvious one-sided deletion.";
  },
};

export default deleteNoChange;
