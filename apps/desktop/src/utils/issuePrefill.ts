/**
 * What a new issue is prefilled with when it is filed from something the user
 * is looking at (#301). The text lands in a GitHub issue that other people
 * read, so it is fixed English, not the app's locale.
 */

import type { DiffLine, GitLogEntry } from "./backend";

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
function codeBlock(text: string, lang = "text"): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
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

/** Lines selected in a commit or PR diff, to file an issue about (#301). */
export interface DiffSelection {
  path: string;
  /** A renamed file's path before the change (where its deleted lines are). */
  oldPath?: string;
  /** Selected rows, in diff order, all from one hunk. */
  lines: DiffLine[];
  source:
    | { kind: "commit"; hash: string; hashFull: string; parent: string | null }
    | { kind: "pr"; number: number; url: string; headSha: string | null };
  /** Text typed before (the PR compose box): starts the body. */
  intro?: string;
  /** Told once the issue form has opened with this selection (the view
   *  that owns it then lets it go: the PR compose box closes). */
  onOpened?: () => void;
}

/** Which version of the file, and which of its lines, a permalink points at. */
export interface LineSpan {
  side: "old" | "new";
  from: number;
  to: number;
}

/** The most selected lines written into an issue's block. */
export const SELECTION_MAX_LINES = 200;
/** The most characters of the whole body, well under GitHub's 65 536. */
const SELECTION_MAX_CHARS = 60_000;
/** The most characters kept of the text typed before (the PR compose box). */
const SELECTION_MAX_INTRO = 20_000;

/**
 * The lines a selection covers in one version of the file: the old version
 * when every line is a deletion (they exist nowhere else), the new one
 * otherwise. Null when no line carries a number on that side.
 */
export function permalinkSpan(lines: DiffLine[]): LineSpan | null {
  const old = lines.length > 0 && lines.every((l) => l.type === "delete");
  const nums = lines
    .filter((l) => (old ? l.type === "delete" : l.type !== "delete"))
    .map((l) => (old ? l.oldLineNo : l.newLineNo))
    .filter((n): n is number => typeof n === "number");
  if (nums.length === 0) return null;
  return { side: old ? "old" : "new", from: Math.min(...nums), to: Math.max(...nums) };
}

/** GitHub's link to `span` of `path` at `sha` (each path segment encoded). */
export function blobPermalink(repoHtmlUrl: string, sha: string, path: string, span: LineSpan): string {
  const file = path.split("/").map(encodeURIComponent).join("/");
  const lines = span.from === span.to ? `L${span.from}` : `L${span.from}-L${span.to}`;
  return `${repoHtmlUrl.replace(/\/+$/, "")}/blob/${sha}/${file}#${lines}`;
}

/**
 * An issue about the selected lines: the text typed before, the permalink
 * (when the lines are reachable on GitHub), the lines as a diff block, and
 * where they come from. `commitUrl` links a commit source; null writes its
 * full SHA unlinked, like `commitIssuePrefill`.
 */
export function selectionIssuePrefill(
  sel: DiffSelection,
  links: { permalink: string | null; commitUrl: string | null },
): IssuePrefill {
  const span = permalinkSpan(sel.lines);
  // Deleted lines of a renamed file live under its old path.
  const path = span?.side === "old" && sel.oldPath ? sel.oldPath : sel.path;
  const old = span?.side === "old" ? " old" : "";
  const where = span ? (span.from === span.to ? `${old} line ${span.from}` : `${old} lines ${span.from}–${span.to}`) : "";
  const src = sel.source;
  const origin =
    src.kind === "commit"
      ? links.commitUrl
        ? `commit [\`${src.hash}\`](${links.commitUrl})`
        : `commit \`${src.hashFull}\``
      : `pull request [#${src.number}](${src.url})`;
  const footer = `${codeSpan(path)}${where}, ${origin}`;
  let intro = sel.intro?.trim() ?? "";
  if (intro.length > SELECTION_MAX_INTRO) intro = intro.slice(0, SELECTION_MAX_INTRO) + "…";

  // Whatever the rest takes comes off the lines' share of the budget.
  const budget = Math.max(1000, SELECTION_MAX_CHARS - intro.length - (links.permalink?.length ?? 0) - footer.length);
  const all = sel.lines.map((l) => (l.type === "add" ? "+" : l.type === "delete" ? "-" : " ") + l.content);
  const rows: string[] = [];
  let chars = 0;
  for (const row of all.slice(0, SELECTION_MAX_LINES)) {
    if (chars + row.length + 1 > budget) break;
    rows.push(row);
    chars += row.length + 1;
  }
  // One line longer than the whole budget: show its start rather than nothing.
  if (rows.length === 0 && all.length > 0) rows.push(all[0].slice(0, budget));
  let block = codeBlock(rows.join("\n"), "diff");
  if (sel.lines.length > rows.length) {
    block += `\n(first ${rows.length} of ${sel.lines.length} lines)`;
  }
  const parts: string[] = [];
  if (intro) parts.push(intro);
  if (links.permalink) parts.push(links.permalink);
  parts.push(block, footer);
  return { title: "", body: parts.join("\n\n") + "\n" };
}
