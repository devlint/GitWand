/**
 * The combined diff's backend errors, in the user's language. Both backends
 * answer the same English strings (`combined/mod.rs`, `combined/replay.rs`,
 * `combined/lineage.rs`, `devCombinedDiff`, `devFileLineage`); a known one maps to its `combined.err*` key with its
 * argument, anything else is shown as is. Imported by the combined view and
 * `useCombinedDiff` only, so it stays in that lazy chunk.
 */
import { COMBINE_MAX } from "../composables/useCommitSelection";
import type { LocaleKey } from "../locales";

type T = (key: LocaleKey, ...args: Array<string | number>) => string;

const PATTERNS: [RegExp, LocaleKey][] = [
  [/^Combined diffs need git 2\.38 or later \(found (.+)\)\.$/s, "combined.errGit"],
  [/^Invalid commit hash: (.*)$/s, "combined.errHash"],
  [/^Unknown commit: (.*)$/s, "combined.errUnknown"],
  [/^Combined diffs do not support the file name: (.*)$/s, "combined.errName"],
  [/^File history too long: more than (\d+) commits\.$/, "combined.errHistoryTooLong"],
];

/** What both backends answer for a replay a newer request superseded
 *  (`combined/replay.rs`, `devCombinedDiff`). */
export const COMBINED_CANCELLED = "Combined diff cancelled.";

/** A rejection's text, verbatim: an `Error`'s message, or the string Tauri's
 *  `invoke` rejects with. */
export function rawErrorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function combinedErrorMessage(raw: string, t: T): string {
  if (raw === COMBINED_CANCELLED) return t("combined.errCancelled");
  if (raw === "Select at least 2 commits.") return t("combined.errMin");
  if (raw === `Select at most ${COMBINE_MAX} commits.`) return t("combined.tooMany", COMBINE_MAX);
  for (const [re, key] of PATTERNS) {
    const m = re.exec(raw);
    if (m) return t(key, m[1]);
  }
  return raw;
}
