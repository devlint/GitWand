/**
 * prAnnotations.ts
 *
 * Shared `LineAnnotation` model (E1, v3.6.0) — a forge-agnostic, source-
 * agnostic line annotation used to merge CI check-run annotations, AI
 * pre-review findings (C4), and static-flag heuristics (E2) into one
 * overlay stream for `PrInlineDiff.vue`. Deliberately keeps an *open*
 * severity scale (not the old 3-level `mapAnnotation` normalization) so AI
 * findings can carry their own confidence/severity untouched.
 *
 * Pure module — no Vue, no composable state — testable in isolation.
 */
import type { CIAnnotation } from "../utils/backend";
import type { ReviewFinding } from "./usePrPreReview";

export type AnnotationSource = "ci" | "ai" | "static";
export type LineSide = "LEFT" | "RIGHT";

export interface LineAnnotation {
  source: AnnotationSource;
  path: string;
  /** Anchor line (start of the range for multi-line annotations). */
  line: number;
  /** Which diff side the line number refers to. Defaults to RIGHT (new side)
   *  at the call site — CI annotations and most AI findings are anchored on
   *  the head commit. */
  side: LineSide;
  endLine?: number;
  /** Open severity scale: "failure"|"warning"|"notice" (CI), "risk"|
   *  "suggestion"|"nit" (AI/static), or any future source's own vocabulary. */
  severity: string;
  /** 0-100 — AI findings only. */
  confidence?: number;
  title: string;
  message?: string;
  /** CI source only — the check-run/job/report name. */
  checkName?: string;
  /** AI source only — a stable id for dismissal/navigation (C2/C4). */
  id?: string;
}

/** Range annotations are expanded line-by-line; capped so a report spanning
 *  a whole file doesn't flag hundreds of rows. */
export const ANN_RANGE_CAP = 20;

/** Map a v2.18 `CIAnnotation` (new-side only) onto the shared model. */
export function fromCIAnnotation(a: CIAnnotation): LineAnnotation {
  return {
    source: "ci",
    path: a.path,
    line: a.startLine,
    side: "RIGHT",
    endLine: a.endLine,
    severity: a.level,
    title: a.title,
    message: a.message,
    checkName: a.checkName,
  };
}

/** Map an AI pre-review finding (C1-C3) onto the shared model (C4). */
export function fromFinding(f: ReviewFinding): LineAnnotation {
  return {
    source: "ai",
    path: f.path,
    line: f.line,
    side: f.side,
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
    message: f.detail,
    id: f.id,
  };
}

/**
 * Group annotations by `${side}:${line}` so LEFT and RIGHT annotations on
 * the same line number never merge (old/new sides are independent). Range
 * annotations are expanded line-by-line, capped at `cap` lines.
 */
export function annotationsByLine(
  anns: LineAnnotation[],
  cap: number = ANN_RANGE_CAP,
): Map<string, LineAnnotation[]> {
  const map = new Map<string, LineAnnotation[]>();
  for (const a of anns) {
    const end = Math.min(a.endLine ?? a.line, a.line + cap - 1);
    for (let l = a.line; l <= end; l++) {
      const key = `${a.side}:${l}`;
      const list = map.get(key);
      if (list) list.push(a);
      else map.set(key, [a]);
    }
  }
  return map;
}

/** Lower rank = more severe. Unknown severities sort last (still shown, just
 *  never picked as "worst" over a recognized one). */
const SEVERITY_RANK: Record<string, number> = {
  failure: 0,
  risk: 0,
  warning: 1,
  suggestion: 1,
  notice: 2,
  nit: 2,
};

/** The most severe annotation's severity string, for the gutter icon. Falls
 *  back to the first annotation's own severity when none are recognized
 *  (still deterministic, never throws on an unknown vocabulary). */
export function worstSeverity(anns: LineAnnotation[]): string {
  if (!anns.length) return "notice";
  let best = anns[0];
  let bestRank = SEVERITY_RANK[best.severity] ?? Infinity;
  for (const a of anns.slice(1)) {
    const rank = SEVERITY_RANK[a.severity] ?? Infinity;
    if (rank < bestRank) {
      best = a;
      bestRank = rank;
    }
  }
  return best.severity;
}
