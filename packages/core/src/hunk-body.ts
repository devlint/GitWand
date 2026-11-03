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
 * Blank context lines: git normally writes one as `" "`, but with
 * `diff.suppressBlankEmpty=true` (or a forge/API that trims trailing
 * whitespace) it is `""`. Inside a bounded hunk — counts left on BOTH sides —
 * `""` is therefore a context line and consumes one line of each count.
 * Outside a hunk, or once either count is used up, `""` is ignored. The
 * bound is what keeps this from creating phantom context lines: the
 * AGENTS.md gotcha is about unbounded parsers that accept any line not
 * starting with `\`.
 *
 * Mirrors `HunkBody` in apps/desktop/src-tauri/src/git/parse.rs — keep the
 * two in sync (apps/desktop/dev-server.mjs uses this module).
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

/** Body of the hunk opened by `header`, bounded by the given counts. */
export function hunkBodyFor(header: string, oldCount: number, newCount: number): HunkBody {
  if (header.startsWith("@@@")) return { oldLeft: 0, newLeft: 0, unbounded: true };
  return { oldLeft: Math.max(0, oldCount), newLeft: Math.max(0, newCount), unbounded: false };
}

/**
 * Body of the hunk opened by the `@@` line `header`, its counts parsed from
 * it (1 each when unparsable, as for an omitted count).
 */
export function hunkBodyFromHeader(header: string): HunkBody {
  const range = parseHunkHeader(header);
  return hunkBodyFor(header, range?.oldCount ?? 1, range?.newCount ?? 1);
}

export type HunkLineKind = "add" | "delete" | "context";

/**
 * Classify one line against `body` and consume it from the counts. Returns
 * null once the body is exhausted, or for a line that is not a hunk line
 * (`\ No newline at end of file`, or `""` when it cannot be a blank context
 * line — see the module doc). A `"context"` line's content is
 * `line.slice(1)`, which is `""` for both `" "` and `""`.
 */
export function classifyHunkLine(body: HunkBody, line: string): HunkLineKind | null {
  if (body.unbounded) {
    // Combined diff: no usable counts, classified by first character only.
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "delete";
    if (line.startsWith(" ")) return "context";
    return null;
  }
  // Strict counts: each kind needs room on the side(s) it consumes, so a hunk
  // whose header undercounts its body ends there — a following `--- a/x`
  // header is then read as a header (fails closed), not as a deletion.
  if (line.startsWith("+")) {
    if (body.newLeft <= 0) return null;
    body.newLeft--;
    return "add";
  }
  if (line.startsWith("-")) {
    if (body.oldLeft <= 0) return null;
    body.oldLeft--;
    return "delete";
  }
  if (line.startsWith(" ") || line === "") {
    if (body.oldLeft <= 0 || body.newLeft <= 0) return null;
    body.oldLeft--;
    body.newLeft--;
    return "context";
  }
  return null;
}
