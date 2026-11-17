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

/** `text` as a Markdown quote, blank lines kept as bare `>`. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

/**
 * An issue about `entry`: titled with its summary, the body naming the commit
 * and its author and quoting the whole message. `commitUrl` is null when the
 * commit is on no remote: the full SHA is then written unlinked, so the issue
 * never carries a link that answers 404.
 */
export function commitIssuePrefill(entry: GitLogEntry, commitUrl: string | null): IssuePrefill {
  const sha = commitUrl ? `[\`${entry.hash}\`](${commitUrl})` : `\`${entry.hashFull}\``;
  const message = [entry.message, entry.body.trim()].filter(Boolean).join("\n\n");
  return {
    title: entry.message,
    body: `Commit ${sha} by ${entry.author}\n\n${quote(message)}\n`,
  };
}
