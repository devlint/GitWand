import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { scopeImpact, makeScore, normalizeForWhitespaceCheck, extractQuotedSegments } from "./utils.js";

const whitespaceOnly: PatternPlugin = {
  type: "whitespace_only",
  priority: 50,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    const oursNorm = normalizeForWhitespaceCheck(h.oursLines);
    const theirsNorm = normalizeForWhitespaceCheck(h.theirsLines);
    if (oursNorm !== theirsNorm) return false;
    // Garde string-literal : la normalisation collapse aussi le whitespace à
    // l'intérieur des strings, or là c'est de la DONNÉE ("hello  world" ≠
    // "hello world"). Les segments quotés doivent être strictement identiques
    // des deux côtés, sinon le conflit n'est pas purement cosmétique.
    const oursQuoted = extractQuotedSegments(h.oursLines);
    const theirsQuoted = extractQuotedSegments(h.theirsLines);
    return oursQuoted.length === theirsQuoted.length &&
      oursQuoted.every((s, i) => s === theirsQuoted[i]);
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
            "Base available: whitespace confirmed against the ancestor",
            "Only whitespace differs after normalisation",
          ]
        : ["Only whitespace differs after normalisation (trim)"],
      hasBase ? [] : ["No base (diff2): the assumption rests on normalisation alone"],
    );
  },

  explanation(_h: ClassifyInput): string {
    return "Both branches contain the same code, differing only in whitespace.";
  },

  passReason(_h: ClassifyInput): string {
    return "After normalisation (trim) the two versions are identical: only whitespace differs.";
  },

  failReason(_h: ClassifyInput): string {
    return "After normalisation (trim) the two versions still differ, so this is more than whitespace.";
  },
};

export default whitespaceOnly;
