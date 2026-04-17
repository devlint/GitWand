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
      oursMatchesBase ? "Seul theirs a modifié le bloc" : "Seul ours a modifié le bloc",
    ], []);
  },

  explanation(h: ClassifyInput): string {
    const oursText = h.oursLines.join("\n");
    const baseText = h.baseLines.join("\n");
    if (oursText === baseText) {
      return "Seule la branche entrante (theirs) a modifié ce bloc. Résolution : accepter theirs.";
    }
    return "Seule la branche courante (ours) a modifié ce bloc. Résolution : accepter ours.";
  },

  passReason(h: ClassifyInput): string {
    const oursText = h.oursLines.join("\n");
    const baseText = h.baseLines.join("\n");
    if (oursText === baseText) {
      return "Ours est identique à la base, seul theirs a changé.";
    }
    return "Theirs est identique à la base, seul ours a changé.";
  },

  failReason(_h: ClassifyInput): string {
    return "Les deux branches ont modifié le bloc par rapport à la base.";
  },
};

export default oneSideChange;
