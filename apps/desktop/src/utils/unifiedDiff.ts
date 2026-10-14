/**
 * unifiedDiff.ts
 *
 * Task 0 (v3.7.0) — pure unified-diff parsing helpers, lifted verbatim out of
 * `usePrPanel.ts` (A1, v3.6.0) so any composable can index/parse a raw
 * unified diff without importing the (very large) PR panel. No Vue, no
 * backend import — safe to use from `useCommitReview.ts` and anywhere else
 * that just needs `GitDiff`s out of a raw diff string.
 *
 * `usePrPanel.ts` re-exports these three functions for backward
 * compatibility — existing callers (`useReviewIntelligence.ts`,
 * `usePrPanel-lazy-diff.test.ts`) keep importing from `../usePrPanel`
 * unmodified.
 */
import type { GitDiff, DiffHunk } from "./backend";
import {
  classifyHunkLine,
  hunkBodyFromHeader,
  noHunkBody,
  parseHunkHeader,
  type HunkBody,
} from "@gitwand/core";

/** Split a raw unified diff into lightweight per-file slices (no hunk parse). */
export function indexDiffFiles(rawDiff: string): { path: string; raw: string }[] {
  const slices: { path: string; raw: string }[] = [];
  if (!rawDiff.trim()) return slices;
  const lines = rawDiff.split("\n");
  let currentPath: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentPath !== null) slices.push({ path: currentPath, raw: currentLines.join("\n") });
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      currentPath = match ? match[2] : "unknown";
      currentLines = [line];
      continue;
    }
    if (currentPath !== null) currentLines.push(line);
  }
  flush();
  return slices;
}

/** Parse one file's raw `diff --git …` slice (as produced by `indexDiffFiles`)
 *  into hunks/lines. Diff-parsing gotcha (AGENTS.md): context lines are
 *  detected via `line.startsWith(' ')`, a bare empty string mid-hunk is
 *  also treated as a (whitespace-stripped) context line, never as a phantom
 *  add/delete. A raw diff always ends with a newline (and `indexDiffFiles`
 *  joins slices with `"\n"` too), so `split("\n")` yields exactly one
 *  trailing `""` element that is not a diff line at all, v3.7.0 review-round
 *  fix (finding #10) drops exactly that trailing element (see below) before
 *  any line is classified, so it can never be mistaken for a genuine blank
 *  context line and pushed onto the last hunk as a phantom zero-length row. */
export function parseFileDiff(rawFileSlice: string): GitDiff {
  const file: GitDiff = { path: "unknown", hunks: [] };
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0, newLine = 0;
  const lines = rawFileSlice.split("\n");
  // A raw diff ends with a newline, so `split("\n")` yields one trailing ""
  // element that is not a diff line at all. Dropping exactly that element
  // (and only when it is last) keeps a genuine blank context line mid-hunk
  // intact, while removing the phantom zero-length context row that
  // otherwise lands on the last hunk of the last file and pushes its line
  // counters past the hunk header. Same bug class the Rust parser fixed in
  // src-tauri/src/commands/read.rs (a phantom trailing context line makes
  // `git apply` reject the patch).
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Remaining body of the current hunk, from its `@@` counts. Inside it a line
  // is classified by its first character only: a removed `-- note` is the
  // diff line `--- note`, an added `++x` is `+++x`, and neither is a file
  // header. The `---`/`+++`/`index`… header skip below only runs outside it.
  // A bare "" while both counts remain is a blank context line
  // (`diff.suppressBlankEmpty`, or trailing-whitespace trimming by a forge).
  let body: HunkBody = noHunkBody();
  for (const line of lines) {
    if (currentHunk) {
      const kind = classifyHunkLine(body, line);
      if (kind === "add") {
        currentHunk.lines.push({ type: "add", content: line.substring(1), newLineNo: newLine++ });
        continue;
      }
      if (kind === "delete") {
        currentHunk.lines.push({ type: "delete", content: line.substring(1), oldLineNo: oldLine++ });
        continue;
      }
      if (kind === "context") {
        currentHunk.lines.push({ type: "context", content: line.substring(1), oldLineNo: oldLine++, newLineNo: newLine++ });
        continue;
      }
    }
    if (line.startsWith("diff --git ")) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      file.path = match ? match[2] : "unknown";
      currentHunk = null;
      body = noHunkBody();
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
        line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("new file ") ||
        line.startsWith("deleted file ") || line.startsWith("similarity index ") ||
        line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("Binary files ")) continue;
    const range = parseHunkHeader(line);
    if (range) {
      currentHunk = { header: line, ...range, lines: [] };
      file.hunks.push(currentHunk);
      oldLine = range.oldStart;
      newLine = range.newStart;
      body = hunkBodyFromHeader(line);
    }
    // Anything else outside a hunk body ("\ No newline at end of file", a
    // line past the header's counts) is not a hunk line.
  }
  return file;
}

/** Full eager parse — composed from `indexDiffFiles` + `parseFileDiff`.
 *  Not used on the hot path anymore (see `usePrPanel.ensureFileParsed`); kept
 *  for regression-parity tests and any caller that genuinely wants
 *  everything parsed up front. */
export function parseUnifiedDiff(rawDiff: string): GitDiff[] {
  return indexDiffFiles(rawDiff).map((f) => parseFileDiff(f.raw));
}
