/**
 * reviewFixPrompt.ts
 *
 * Task 3 (v3.7.0) — pure builder for the plain-text instruction block typed
 * into an agent's PTY after "Fix with agent" (never auto-submitted — the
 * user presses Enter themselves; plan decision D7). Findings only: no
 * secrets, no API keys, no env dump (AGENTS.md: never log/pass secrets).
 *
 * Newline-safe for PTY injection: `\r` is stripped and any interior newline
 * in a finding's `detail` is collapsed to a space, so the whole block can be
 * typed as a single `terminalWrite` payload without corrupting the agent's
 * line editor. Also strips every other C0 control character (title/detail
 * are parsed from an AI response to an arbitrary diff, so a crafted diff
 * could in principle smuggle an ANSI escape sequence or similar into the
 * raw PTY write this prompt ends up in).
 */
import type { ReviewFinding } from "../composables/usePrPreReview";
import { sortFindingsForReview } from "./reviewFindingsSort";

const DEFAULT_MAX_FINDINGS = 25;

/** Strip `\r`, collapse any run of newlines to a single space, then strip
 *  every remaining C0 control character (tab, ESC, NUL, BEL, ...) and DEL —
 *  keeps a finding's title/detail on one physical, control-byte-free line. */
function sanitizeLine(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\s*\n+\s*/g, " ")
    // eslint-disable-next-line no-control-regex -- deliberate: stripping C0 controls + DEL
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

export interface BuildReviewFixPromptOptions {
  /** Max findings included before an "and N more" tail. Default 25. */
  maxFindings?: number;
}

/**
 * Builds the fix-with-agent prompt: a one-line mission followed by one
 * bullet per finding (severity-sorted, same order as `CommitReviewModal`'s
 * list and the `N`/`P` nav cursor), capped and tailed with a count of any
 * findings left out. Empty input returns an empty string — nothing to type.
 */
export function buildReviewFixPrompt(
  findings: ReviewFinding[],
  opts: BuildReviewFixPromptOptions = {},
): string {
  if (!findings.length) return "";
  const max = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const sorted = sortFindingsForReview(findings);
  const shown = sorted.slice(0, Math.max(0, max));

  const lines: string[] = [
    "Fix the following issues in the staged changes; keep the changes minimal and staged.",
  ];
  for (const f of shown) {
    const title = sanitizeLine(f.title);
    const detail = sanitizeLine(f.detail);
    const body = detail ? `${title} - ${detail}` : title;
    lines.push(`- ${f.path}:${f.line} [${f.severity}, ${f.confidence}%] ${body}`);
  }
  const remaining = sorted.length - shown.length;
  if (remaining > 0) lines.push(`... and ${remaining} more`);

  return `${lines.join("\n")}\n`;
}
