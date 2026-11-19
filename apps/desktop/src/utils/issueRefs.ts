/**
 * Issue references in commit messages (#301, part 4).
 *
 * Pure text helpers: find the `#query` under the caret, filter the open
 * issues it names, and write the reference (`#N`, or `owner/repo#N` for an
 * issue that lives in another repository than the one pushed to).
 */
import type { Issue } from "./backend";

/** The suggestion list never shows more rows than this. */
export const MAX_ISSUE_ROWS = 8;

/** A `#` opens the list at the start of the text or after one of these. */
const OPENS_AFTER = /[\s(]/;

/**
 * The `#query` the caret is in, or null. The `#` must start the text or follow
 * whitespace or `(`; the query runs from it to the caret with no whitespace.
 */
export function hashTokenAt(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("#");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  if (start > 0 && !OPENS_AFTER.test(text[start - 1])) return null;
  return { start, query };
}

/** Digits match the number by prefix; anything else the title. Most recently updated first. */
export function filterIssues(issues: Issue[], query: string, max = MAX_ISSUE_ROWS): Issue[] {
  const q = query.trim().toLowerCase();
  const match = /^\d+$/.test(q)
    ? (i: Issue) => String(i.number).startsWith(q)
    : (i: Issue) => i.title.toLowerCase().includes(q);
  return issues
    .filter(match)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number))
    .slice(0, max);
}

/** `owner/repo` (or `group/sub/project`) from an issue's web URL. */
export function repoSlugFromUrl(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?issues\/\d+/.exec(url);
  return m ? m[1] : null;
}

/** `#N`, qualified as `issueRepo#N` when that is not the repository pushed to. */
export function issueRef(number: number, issueRepo: string | null, pushRepo: string | null): string {
  const norm = (r: string) => r.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!issueRepo || !pushRepo || norm(issueRepo) === norm(pushRepo)) return `#${number}`;
  return `${issueRepo}#${number}`;
}

/** Replace `text[start, caret)` (the `#query`) with the reference and a space. */
export function insertRef(
  text: string,
  start: number,
  caret: number,
  ref: string,
  fixes: boolean,
): { text: string; caret: number } {
  const inserted = `${fixes ? "Fixes " : ""}${ref} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `ref` appears in `text` as a whole reference (`#4` is not in `#42` or `up/app#4`). */
export function hasRef(text: string, ref: string): boolean {
  return new RegExp(`(^|[^\\w/.-])${escapeRegExp(ref)}(?!\\w)`).test(text);
}

/** The description with ` ref` appended, unchanged when the message already cites it. */
export function appendRef(description: string, ref: string, summary = ""): string {
  if (hasRef(summary, ref) || hasRef(description, ref)) return description;
  const trimmed = description.replace(/\s+$/, "");
  return trimmed ? `${trimmed} ${ref}` : ref;
}

/**
 * The "issue created" toast's "Add to commit" (#301): the new description, or
 * null when the repository changed since the issue was filed, or the message
 * already cites it.
 */
export function addCreatedIssueToCommit(
  issueUrl: string,
  number: number,
  createdIn: string,
  activeCwd: string,
  pushRepo: string | null,
  summary: string,
  description: string,
): string | null {
  if (createdIn !== activeCwd) return null;
  const ref = issueRef(number, repoSlugFromUrl(issueUrl), pushRepo);
  if (hasRef(summary, ref) || hasRef(description, ref)) return null;
  return appendRef(description, ref, summary);
}
