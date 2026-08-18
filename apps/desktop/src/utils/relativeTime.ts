// utils/relativeTime.ts — shared, i18n-safe relative-age formatter.
//
// Consolidates three near-identical `timeAgo` implementations
// (usePrPanel.ts, PrCommentThread.vue, PullRequestPanel.vue) that hardcoded
// a French-only unit letter ("j" for days) regardless of the active locale,
// and that rendered "NaNj" for any unparseable date instead of degrading
// gracefully — the same class of bug already fixed once for Stash/Tags
// dates (#151), never applied to the PR panel (#161).
import type { LocaleKey } from "../locales";

type Translate = (key: LocaleKey, ...args: Array<string | number>) => string;

/** Format an ISO date string as a short, fully localized relative age
 *  ("3m ago", "2h ago", "5d ago", …). Returns "" for an empty or
 *  unparseable date rather than "NaNj" / "Invalid Date". */
export function formatRelativeAge(iso: string | null | undefined, t: Translate): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t("date.now");
  if (mins < 60) return t("date.minutesAgo", mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("date.hoursAgo", hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return t("date.daysAgo", days);
  if (days < 30) return t("date.weeksAgo", Math.floor(days / 7));
  if (days < 365) return t("date.monthsAgo", Math.floor(days / 30));
  return t("date.yearsAgo", Math.floor(days / 365));
}
