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
  // Letters, digits, `_` and `-` only: a space or punctuation (`#12)`, `#12,`, `#12.`) ends it.
  if (!/^[\p{L}\p{N}_-]*$/u.test(query)) return null;
  if (start > 0 && !OPENS_AFTER.test(text[start - 1])) return null;
  return { start, query };
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

/** `owner/repo` from a remote's parts (GitLab subgroups live in `repo`), or null. */
export function remoteSlug(info: { owner: string; repo: string } | null | undefined): string | null {
  return info?.owner && info.repo ? `${info.owner}/${info.repo}` : null;
}

/** `#N`, qualified as `issueRepo#N` when that is not the repository pushed to. */
export function issueRef(number: number, issueRepo: string | null, pushRepo: string | null): string {
  const norm = (r: string) => r.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!issueRepo) return `#${number}`;
  // Pushed repository unknown: `owner/repo#N` is right wherever the commit lands.
  if (!pushRepo) return `${issueRepo}#${number}`;
  const [issue, push] = [norm(issueRepo), norm(pushRepo)];
  // A forge served under a path (`host/gitlab/grp/proj`) puts that path in
  // the issue URL but not in the remote's owner/repo.
  if (issue === push || issue.endsWith(`/${push}`)) return `#${number}`;
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

/** A trailer line (`Signed-off-by: A <a@x>`): git only reads them in the last paragraph. */
const TRAILER = /^[A-Za-z][\w-]*: \S/;
/** GitWand's commit signature (`useGitRepo`, App): a closing paragraph, kept last. */
export const COMMIT_SIGNATURE = "\u{1FA84} Commit via GitWand";
/** A paragraph is a trailer block only with one of these (`Note: …` alone is prose). */
const KNOWN_TRAILER = /^(Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Helped-by|Cc|Change-Id):/i;

/**
 * The description citing `ref`, unchanged when the message already does. The
 * reference is a paragraph of its own (a closing fence, a list item or a
 * trailer is never extended), placed before a closing trailer block.
 */
export function appendRef(description: string, ref: string, summary = ""): string {
  if (hasRef(summary, ref) || hasRef(description, ref)) return description;
  const trimmed = description.replace(/\s+$/, "");
  if (!trimmed) return ref;
  const paragraphs = trimmed.split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1];
  const lines = last.split("\n");
  const closing = last === COMMIT_SIGNATURE || (lines.every((line) => TRAILER.test(line)) && lines.some((line) => KNOWN_TRAILER.test(line)));
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
  if (ctx.createdIn !== ctx.activeCwd) return { status: "otherRepo" };
  const repo = repoSlugFromUrl(issue.url) ?? issue.repo;
  const ref = issueRef(issue.number, repo, ctx.pushRepo);
  // Already cited in any form: `#N`, `owner/repo#N` or the issue's URL.
  const forms = [ref, repo ? `${repo}#${issue.number}` : null, issue.url || null].filter((f): f is string => !!f);
  if (forms.some((f) => hasRef(ctx.summary, f) || hasRef(ctx.description, f))) return { status: "alreadyCited" };
  return { status: "added", description: appendRef(ctx.description, ref, ctx.summary) };
}
