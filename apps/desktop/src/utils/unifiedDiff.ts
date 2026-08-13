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
 *  detected via `line.startsWith(' ')` — a bare empty string is also treated
 *  as a (whitespace-stripped) context line, never as a phantom add/delete. */
export function parseFileDiff(rawFileSlice: string): GitDiff {
  const file: GitDiff = { path: "unknown", hunks: [] };
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0, newLine = 0;
  for (const line of rawFileSlice.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      file.path = match ? match[2] : "unknown";
      currentHunk = null;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
        line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("new file ") ||
        line.startsWith("deleted file ") || line.startsWith("similarity index ") ||
        line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("Binary files ")) continue;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      };
      file.hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      continue;
    }
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.substring(1), newLineNo: newLine++ });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "delete", content: line.substring(1), oldLineNo: oldLine++ });
      } else if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({ type: "context", content: line.startsWith(" ") ? line.substring(1) : line, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }
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
