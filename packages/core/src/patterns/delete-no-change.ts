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
          ? "Ours a supprimé, theirs identique à la base"
          : "Theirs a supprimé, ours identique à la base",
      ], []);
    }
    return makeScore(60, 30, 0, [], [
      "Sans base (diff2) — suppression non confirmée par rapport à l'ancêtre commun",
    ]);
  },

  explanation(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      const baseText = h.baseLines.join("\n");
      const theirsText = h.theirsLines.join("\n");
      if (h.oursLines.length === 0 && theirsText === baseText) {
        return "La branche courante (ours) a supprimé ce bloc, l'autre ne l'a pas modifié. Résolution : supprimer.";
      }
      return "La branche entrante (theirs) a supprimé ce bloc, l'autre ne l'a pas modifié. Résolution : supprimer.";
    }
    if (h.oursLines.length === 0) {
      return "La branche courante (ours) a supprimé ce bloc. Sans base, confiance moyenne. Résolution proposée : supprimer.";
    }
    return "La branche entrante (theirs) a supprimé ce bloc. Sans base, confiance moyenne. Résolution proposée : supprimer.";
  },

  passReason(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      const baseText = h.baseLines.join("\n");
      const theirsText = h.theirsLines.join("\n");
      if (h.oursLines.length === 0 && theirsText === baseText) {
        return "Ours a supprimé le bloc (0 lignes) et theirs n'a pas modifié la base.";
      }
      return "Theirs a supprimé le bloc (0 lignes) et ours n'a pas modifié la base.";
    }
    if (h.oursLines.length === 0) {
      return "Ours est vide (0 lignes) en diff2. Suppression probable mais incertaine sans base.";
    }
    return "Theirs est vide (0 lignes) en diff2. Suppression probable mais incertaine sans base.";
  },

  failReason(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    if (hasBase) {
      return "Ni ours ni theirs n'est une suppression unilatérale avec l'autre côté identique à la base.";
    }
    return "Ni ours ni theirs n'est vide en diff2 — pas de suppression unilatérale évidente.";
  },
};

export default deleteNoChange;
