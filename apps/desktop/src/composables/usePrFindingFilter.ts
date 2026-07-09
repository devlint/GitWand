/**
 * usePrFindingFilter.ts
 *
 * Signal/noise controls for AI pre-review findings (C2, v3.6.0) — pure,
 * no Vue state: confidence threshold, top-N cap by confidence, and local
 * dismissal memory keyed by a normalized "finding class" so a dismissed
 * finding stays hidden across recomputes and sessions, even if its exact
 * line number shifts.
 */
import type { ReviewFinding } from "./usePrPreReview";

/**
 * Normalize a finding into a stable class: the file's directory + a
 * digit-collapsed, lower-cased title. Two findings with the same title but
 * a different line number, or a different digit in the title (e.g. "unused
 * variable x2" vs "unused variable x7"), collapse to the same class.
 */
export function normalizeFindingClass(f: { path: string; title: string }): string {
  const slash = f.path.lastIndexOf("/");
  const dir = slash === -1 ? "" : f.path.slice(0, slash);
  const title = f.title.toLowerCase().replace(/\d+/g, "#").trim();
  return `${dir}::${title}`;
}

export interface FilterFindingsOptions {
  /** Minimum confidence (0-100, inclusive) a finding must have to survive. */
  threshold: number;
  /** Top-N cap, applied after threshold + dismissal filtering. */
  cap: number;
  /** Set of `normalizeFindingClass` values the user has dismissed for this repo. */
  dismissed: Set<string>;
}

/** Drop below-threshold and dismissed findings, sort by confidence
 *  descending, and keep only the top `cap`. */
export function filterFindings(all: ReviewFinding[], opts: FilterFindingsOptions): ReviewFinding[] {
  return all
    .filter((f) => f.confidence >= opts.threshold)
    .filter((f) => !opts.dismissed.has(normalizeFindingClass(f)))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, opts.cap);
}
