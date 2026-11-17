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
    title: entry.message,
    body: `Commit ${sha} by ${entry.author}\n\n${codeBlock(message)}\n`,
  };
}
