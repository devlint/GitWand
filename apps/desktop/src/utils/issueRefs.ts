/**
 * Issue references in commit messages (#301, part 4).
 *
 * Pure text helpers: find the `#query` under the caret, filter the open
 * issues it names, and write the reference (`#N`, or `owner/repo#N` for an
 * issue that lives in another repository than the one pushed to).
 */
import type { Issue } from "./backend";
import { COMMIT_SIGNATURE } from "./commitSignature";
import { escapeRegExp } from "./escapeRegExp";

/** The suggestion list never shows more rows than this. */
export const MAX_ISSUE_ROWS = 8;

/** A `#` opens the list at the start of the text or after one of these. */
const OPENS_AFTER = /[\s(]/;

/**
 * The `#query` the caret is in, or null. The `#` must start the text or follow
 * whitespace or `(`; the query runs from it to the caret with no whitespace.
 */
/** A character that continues a `#token`. */
const TOKEN_CHAR = /[\p{L}\p{N}_-]/u;

export function hashTokenAt(text: string, caret: number): { start: number; query: string; end: number } | null {
  if (caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("#");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  // Letters, digits, `_` and `-` only: a space or punctuation (`#12)`, `#12,`, `#12.`) ends it.
  if (![...query].every((c) => TOKEN_CHAR.test(c))) return null;
  if (start > 0 && !OPENS_AFTER.test(text[start - 1])) return null;
  // The token runs on past the caret (`#12|3`): a pick replaces all of it.
  let end = caret;
  while (end < text.length && TOKEN_CHAR.test(text[end])) end++;
  return { start, query, end };
}

/**
 * Digits match the number by prefix, the exact number first; anything else
 * the title. Then most recently updated first.
 */
export function filterIssues(issues: Issue[], query: string, max = MAX_ISSUE_ROWS): Issue[] {
  const q = query.trim().toLowerCase();
  const digits = /^\d+$/.test(q);
  const match = digits ? (i: Issue) => String(i.number).startsWith(q) : (i: Issue) => i.title.toLowerCase().includes(q);
  const exact = (i: Issue) => (digits && String(i.number) === q ? 0 : 1);
  return issues
    .filter(match)
    .sort((a, b) => exact(a) - exact(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number))
    .slice(0, max);
}

/** `owner/repo` (or `group/sub/project`) from an issue's web URL. */
export function repoSlugFromUrl(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?issues\/\d+/.exec(url);
  return m ? m[1] : null;
}

/**
 * The pushed repository's path, as issue URLs spell it: an https remote's
 * whole path (a forge served under `/gitlab/` keeps that prefix), otherwise
 * `owner/repo` (GitLab subgroups live in `repo`). null when unknown.
 */
export function remoteSlug(info: { owner: string; repo: string; url?: string } | null | undefined): string | null {
  const web = info?.url ? /^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/*$/.exec(info.url) : null;
  if (web) return web[1];
  return info?.owner && info.repo ? `${info.owner}/${info.repo}` : null;
}

/** `#N`, qualified as `issueRepo#N` when that is not the repository pushed to. */
export function issueRef(number: number, issueRepo: string | null, pushRepo: string | null): string {
  const norm = (r: string) => r.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!issueRepo) return `#${number}`;
  // Pushed repository unknown: `owner/repo#N` is right wherever the commit lands.
  if (!pushRepo) return `${issueRepo}#${number}`;
  // Exact: `grp/acme/app` (a subgroup project) is not `acme/app`.
  if (norm(issueRepo) === norm(pushRepo)) return `#${number}`;
  return `${issueRepo}#${number}`;
}

/**
 * Replace `text[start, end)` (the whole `#token`) with the reference. A space
 * follows it only before a word or at the end (`fix(#12):`, `#12,` get none).
 * The caret goes past a following space, but stays on the line otherwise.
 */
export function insertRef(
  text: string,
  start: number,
  end: number,
  ref: string,
  fixes: boolean,
): { text: string; caret: number } {
  const inserted = `${fixes ? "Fixes " : ""}${ref}`;
  const rest = text.slice(end);
  const addSpace = rest === "" || /^[\p{L}\p{N}_]/u.test(rest);
  const spaced = addSpace ? `${inserted} ` : inserted;
  const skip = addSpace || /^[ \t]/.test(rest) ? 1 : 0;
  return { text: text.slice(0, start) + spaced + rest, caret: start + inserted.length + skip };
}

/** Whether `ref` appears in `text` as a whole reference (`#4` is not in `#42` or `up/app#4`). */
export function hasRef(text: string, ref: string): boolean {
  return new RegExp(`(^|[^\\w/.-])${escapeRegExp(ref)}(?!\\w)`, "i").test(text);
}

/** A trailer line (`Signed-off-by: A <a@x>`): git only reads them in the last paragraph. */
const TRAILER = /^[A-Za-z][\w-]*: \S/;

/** A paragraph is a trailer block only with one of these (`Note: …` alone is prose). */
const KNOWN_TRAILER = /^(Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Helped-by|Cc|Change-Id):/i;

/**
 * The description with `ref` as a paragraph of its own (a closing fence, a
 * list item or a trailer is never extended), placed before a closing block:
 * GitWand's signature and/or trailers. Whether it is already cited is the
 * caller's check (`addCreatedIssueToCommit`).
 */
export function appendRef(description: string, ref: string): string {
  const trimmed = description.replace(/\s+$/, "");
  if (!trimmed) return ref;
  const paragraphs = trimmed.split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1];
  const lines = last.split("\n");
  const signed = lines[0] === COMMIT_SIGNATURE;
  const trailers = signed ? lines.slice(1) : lines;
  const closing =
    (signed && trailers.length === 0) ||
    (trailers.length > 0 && trailers.every((line) => TRAILER.test(line)) && (signed || trailers.some((line) => KNOWN_TRAILER.test(line))));
  if (closing) {
    return [...paragraphs.slice(0, -1), ref, last].join("\n\n");
  }
  return `${trimmed}\n\n${ref}`;
}

export type AddToCommit = { status: "added"; description: string } | { status: "otherRepo" } | { status: "alreadyCited" };

/**
 * The "issue created" toast's "Add to commit" (#301). `issue.repo` is where it
 * was filed, used when its URL says nothing.
 */
export function addCreatedIssueToCommit(
  issue: { url: string; number: number; repo: string | null },
  ctx: { createdIn: string; activeCwd: string; pushRepo: string | null; summary: string; description: string },
): AddToCommit {
  if (!ctx.createdIn || ctx.createdIn !== ctx.activeCwd) return { status: "otherRepo" };
  const repo = repoSlugFromUrl(issue.url) ?? issue.repo;
  const ref = issueRef(issue.number, repo, ctx.pushRepo);
  // Already cited in any form: `#N`, `owner/repo#N` or the issue's URL; a bare
  // `#N` counts unless it is known to name the pushed repository's issue.
  const bare = !ctx.pushRepo || ref === `#${issue.number}` ? `#${issue.number}` : null;
  const forms = [ref, bare, repo ? `${repo}#${issue.number}` : null, issue.url || null].filter((f): f is string => !!f);
  if (forms.some((f) => hasRef(ctx.summary, f) || hasRef(ctx.description, f))) return { status: "alreadyCited" };
  return { status: "added", description: appendRef(ctx.description, ref) };
}
