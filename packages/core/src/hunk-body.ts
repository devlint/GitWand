/**
 * Hunk-body tracking for unified-diff parsers.
 *
 * A unified diff puts `--- a/x` / `+++ b/x` file headers before each file's
 * hunks — but a hunk line whose *content* starts with `--` or `++` looks the
 * same: a removed SQL comment `-- note` is the diff line `--- note`, an added
 * `++x` is `+++x`. A parser that filters `---`/`+++` everywhere silently
 * drops those lines (and every later line number shifts).
 *
 * The fix is to use the counts of the `@@ -a,b +c,d @@` header: while they
 * are not used up, every line belongs to the hunk and is classified by its
 * first character only. Only once they are exhausted do `---`/`+++` mean
 * file headers again.
 *
 * Mirrors `HunkBody` in apps/desktop/src-tauri/src/git/parse.rs and
 * `devHunkBody` in apps/desktop/dev-server.mjs — keep the three in sync.
 */

/** Old/new start and count of a `@@` hunk header. */
export interface HunkHeaderRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `@@ -a[,b] +c[,d] @@ …`. An omitted count means 1 (unified-diff
 * convention). Returns null for anything else, a combined `@@@` header
 * included.
 */
export function parseHunkHeader(line: string): HunkHeaderRange | null {
  const m = line.match(HUNK_HEADER_RE);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldCount: parseInt(m[2] ?? "1", 10),
    newStart: parseInt(m[3], 10),
    newCount: parseInt(m[4] ?? "1", 10),
  };
}

/** Lines of the current hunk still expected, per side. */
export interface HunkBody {
  oldLeft: number;
  newLeft: number;
  /**
   * Combined-diff hunk (`@@@ … @@@`, from `diff --cc`): its counts are per
   * parent and its lines carry one prefix column per parent, so they cannot
   * bound it. It stays open until the caller resets it on a `diff ` line.
   */
  unbounded: boolean;
}

/** No hunk open (before the first `@@` of a file, or after `diff --git`). */
export function noHunkBody(): HunkBody {
  return { oldLeft: 0, newLeft: 0, unbounded: false };
}

/** Body of the hunk opened by `header`, bounded by its counts. */
export function hunkBodyFor(header: string, oldCount: number, newCount: number): HunkBody {
  if (header.startsWith("@@@")) return { oldLeft: 0, newLeft: 0, unbounded: true };
  return { oldLeft: Math.max(0, oldCount), newLeft: Math.max(0, newCount), unbounded: false };
}

/** True while the hunk's counts are not used up. */
export function hunkBodyActive(body: HunkBody): boolean {
  return body.unbounded || body.oldLeft > 0 || body.newLeft > 0;
}

export type HunkLineKind = "add" | "delete" | "context";

/**
 * Classify one line against `body` and consume it from the counts. Returns
 * null once the body is exhausted, or for a line that is not an
 * add/delete/context line (`\ No newline at end of file`, or an empty
 * string, which is never context — AGENTS.md "Diff Parsing").
 */
export function classifyHunkLine(body: HunkBody, line: string): HunkLineKind | null {
  if (!hunkBodyActive(body)) return null;
  if (line.startsWith("+")) {
    body.newLeft--;
    return "add";
  }
  if (line.startsWith("-")) {
    body.oldLeft--;
    return "delete";
  }
  if (line.startsWith(" ")) {
    body.oldLeft--;
    body.newLeft--;
    return "context";
  }
  return null;
}
