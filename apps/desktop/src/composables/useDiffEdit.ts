/**
 * v3.11.0 — the pure layer under the editable diff.
 *
 * Design: docs/superpowers/specs/2026-09-12-v3.11.0-preview-to-apply-design.md §4.5
 *
 * Two functions that know nothing about Vue, CodeMirror or the backend: turn a
 * hunk into the text currently on disk (`hunkPostImage`), and write edited text
 * back at exactly that hunk's position (`spliceHunk`).
 *
 * Everything genuinely risky about editing a diff in place lives here, because
 * the failure mode is not "the edit did not apply" but "the edit applied one
 * line off", which corrupts a region the user never looked at while they
 * believe they fixed a typo.
 *
 * Two decisions worth stating:
 *
 * **The original string is the source of truth, not `split("\n")`.** A bare
 * split loses whether the file ended with a newline and silently rewrites
 * every CRLF to LF. An editor that normalises line endings across a whole file
 * as a side effect of one inline edit produces a diff nobody asked for.
 *
 * **A stale hunk is refused, never guessed at.** The diff was computed at some
 * earlier moment. If the file changed underneath, the hunk's line range now
 * points somewhere else. Refusing is the only safe answer, and the check is
 * scoped to the range being written so an unrelated edit elsewhere in the file
 * is not a reason to block.
 */

import type { DiffHunk } from "../utils/backend";

export type SpliceResult =
  | { ok: true; text: string }
  | { ok: false; reason: "stale" };

/**
 * The hunk's "after" side: what these lines look like on disk right now.
 *
 * Context and added lines in their original order, deleted lines dropped.
 * That is exactly working-tree lines `[newStart, newStart + newCount)`.
 */
export function hunkPostImage(hunk: DiffHunk): string {
  return hunk.lines
    .filter((l) => l.type !== "delete")
    .map((l) => l.content)
    .join("\n");
}

/** Split into lines while remembering each line's own terminator. */
function splitKeepingEndings(text: string): { lines: string[]; endings: string[] } {
  const lines: string[] = [];
  const endings: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    const hasCr = i > start && text[i - 1] === "\r";
    lines.push(text.slice(start, hasCr ? i - 1 : i));
    endings.push(hasCr ? "\r\n" : "\n");
    start = i + 1;
  }
  // Trailing content with no terminator: a file not ending in a newline.
  if (start <= text.length - 1 || text.length === 0) {
    lines.push(text.slice(start));
    endings.push("");
  }
  return { lines, endings };
}

/**
 * Replace the lines this hunk covers with `replacement`.
 *
 * Returns `{ ok: false, reason: "stale" }` when the file no longer matches the
 * hunk's post-image over that range, which means the diff is out of date and
 * writing would land somewhere unintended.
 */
export function spliceHunk(
  fileText: string,
  hunk: DiffHunk,
  replacement: string,
): SpliceResult {
  const { lines, endings } = splitKeepingEndings(fileText);

  // `newStart` is 1-based; a hunk that adds to an empty file reports 0.
  const from = Math.max(0, hunk.newStart - 1);
  const count = hunk.newCount;
  const to = from + count;

  if (to > lines.length) return { ok: false, reason: "stale" };

  // git keeps the CR of a CRLF file inside each line's *content*, while the
  // splitter above treats it as part of the terminator. Compare with the
  // terminators stripped from both sides so a CRLF file is not mistaken for a
  // stale hunk on every single edit.
  const bare = (l: string) => (l.endsWith("\r") ? l.slice(0, -1) : l);
  const onDisk = lines.slice(from, to).map(bare);
  // A hunk that only deletes has `newCount === 0`, so it covers no lines at
  // all. Its post-image is the empty string, and `"".split("\n")` is `[""]`,
  // one empty line rather than none: comparing that against an empty slice
  // always mismatched and reported a perfectly fresh hunk as stale.
  const post = hunkPostImage(hunk);
  const expected = count === 0 && post === "" ? [] : post.split("\n").map(bare);
  if (onDisk.length !== expected.length || onDisk.some((l, i) => l !== expected[i])) {
    return { ok: false, reason: "stale" };
  }

  // The dominant ending inside the replaced region, so edited text adopts the
  // file's convention instead of whatever the editor happened to emit.
  const regionEndings = endings.slice(from, to).filter(Boolean);
  const eol = regionEndings.includes("\r\n") ? "\r\n" : "\n";

  // Terminators are re-added below, so strip any the replacement carries. The
  // final line needs this explicitly: `split(/\r?\n/)` only consumes a CR that
  // is followed by a LF, so text ending "three\r" keeps it and would produce a
  // doubled CR. That is exactly the shape `hunkPostImage` hands back for a
  // CRLF file, since git keeps the CR in line content.
  // Empty text into a zero-length range means "insert nothing". Without this,
  // `"".split(/\r?\n/)` is `[""]` and the splice writes a blank line, so
  // confirming an untouched delete-only hunk would ADD an empty line to the
  // file. Replacing a non-empty range with "" still collapses it to one empty
  // line, which is the honest reading of the user clearing the editor.
  const replacementLines =
    count === 0 && replacement === "" ? [] : replacement.split(/\r?\n/).map(bare);

  const head = lines
    .slice(0, from)
    .map((l, i) => l + endings[i])
    .join("");

  // Everything after the hunk keeps its own original terminators, including a
  // final line with none.
  const tail = lines
    .slice(to)
    .map((l, i) => l + endings[to + i])
    .join("");

  // The replaced block ends with a terminator only if something follows it, or
  // if the last replaced line originally had one.
  const lastReplacedEnding = endings[to - 1] ?? "";
  const body = replacementLines.length === 0
    ? ""
    : replacementLines
        .map((l, i) => (i < replacementLines.length - 1 ? l + eol : l + (tail ? eol : lastReplacedEnding)))
        .join("");

  return { ok: true, text: head + body + tail };
}
