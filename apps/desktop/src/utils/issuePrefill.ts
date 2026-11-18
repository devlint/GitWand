/**
 * What a new issue is prefilled with when it is filed from something the user
 * is looking at (#301). The text lands in a GitHub issue that other people
 * read, so it is fixed English, not the app's locale.
 */

import type { GitLogEntry } from "./backend";

export interface IssuePrefill {
  title: string;
  body: string;
}

/** The commit page of `sha` on the repository at `repoHtmlUrl`. */
export function commitUrlFor(repoHtmlUrl: string, sha: string): string {
  return `${repoHtmlUrl.replace(/\/+$/, "")}/commit/${sha}`;
}

/**
 * `text` in a fenced code block. Inside one, GitHub neither notifies an
 * `@user` nor cross-links a `#N` (a quote would do both, pinging people and
 * adding events to other issues). The fence is longer than any backtick run
 * in `text`, so the message cannot close it.
 */
function codeBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** `text` as an inline code span (inert: no mention, reference or link). */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  // A span that starts or ends with a backtick needs a space inside its fence.
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** GitHub refuses an issue title longer than this (422). */
export const ISSUE_TITLE_MAX = 256;

/**
 * `text` cut to GitHub's title limit, with an ellipsis. Measured in UTF-16
 * units, like the title field's `maxlength` (the stricter count), and never
 * splitting a surrogate pair.
 */
function issueTitle(text: string): string {
  if (text.length <= ISSUE_TITLE_MAX) return text;
  let cut = text.slice(0, ISSUE_TITLE_MAX - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + "…";
}

/**
 * An issue about `entry`: titled with its summary, the body naming the commit
 * and its author, then the whole message in a code block. `commitUrl` is null
 * when the commit is not on `origin`: the full SHA is then written unlinked,
 * so the issue never carries a link that answers 404.
 */
export function commitIssuePrefill(entry: GitLogEntry, commitUrl: string | null): IssuePrefill {
  const sha = commitUrl ? `[\`${entry.hash}\`](${commitUrl})` : `\`${entry.hashFull}\``;
  const message = [entry.message, entry.body.trim()].filter(Boolean).join("\n\n");
  return {
    title: issueTitle(entry.message),
    body: `Commit ${sha} by ${codeSpan(entry.author)}\n\n${codeBlock(message)}\n`,
  };
}
