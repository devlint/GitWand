/**
 * @file diffRange.ts
 *
 * Pure rules for a range of rows in a PR diff (#301): where GitHub's
 * multi-line comment starts, and where the same rows are after the diff is
 * reloaded.
 */
import type { DiffLine, GitDiff } from "./backend";

/** A diff row's side in GitHub's terms. */
export function sideOf(dl: DiffLine): "LEFT" | "RIGHT" {
  return dl.type === "delete" ? "LEFT" : "RIGHT";
}

/** A diff row's line number on its own side. */
export function lineNoOf(dl: DiffLine): number {
  return (sideOf(dl) === "RIGHT" ? dl.newLineNo : dl.oldLineNo) ?? 0;
}

/**
 * Where GitHub's multi-line comment over `rows` starts (`start_line` /
 * `start_side`); the comment itself sits on the last row. GitHub refuses a
 * range from the new side to the old, so a range ending on a deleted line
 * starts on its first row that exists in the old version. Null for fewer
 * than two rows (a single-line comment) or no such row.
 */
export function githubRangeStart(rows: DiffLine[]): { line: number; side: "LEFT" | "RIGHT" } | null {
  if (rows.length < 2) return null;
  if (sideOf(rows[rows.length - 1]) === "LEFT") {
    const first = rows.find((l) => l.type !== "add");
    return first?.oldLineNo ? { line: first.oldLineNo, side: "LEFT" } : null;
  }
  return { line: lineNoOf(rows[0]), side: sideOf(rows[0]) };
}

function sameRow(a: DiffLine, b: DiffLine): boolean {
  return a.type === b.type && a.content === b.content;
}

/**
 * The same consecutive `rows` in a reloaded diff: every row matching in kind
 * and text, in one hunk. Among several copies (closing braces, blank lines),
 * the one nearest the rows' old line numbers (else new ones) wins. Null when
 * the rows are gone.
 */
export function findBlock(diff: GitDiff, rows: DiffLine[]): { hunkIdx: number; start: number } | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  let best: { hunkIdx: number; start: number } | null = null;
  let bestDist = Infinity;
  for (const [hunkIdx, h] of diff.hunks.entries()) {
    for (let start = 0; start + rows.length <= h.lines.length; start++) {
      if (!rows.every((r, i) => sameRow(h.lines[start + i], r))) continue;
      const at = h.lines[start];
      // Line numbers may be absent or null (the backends send null).
      const dist =
        typeof first.oldLineNo === "number" && typeof at.oldLineNo === "number"
          ? Math.abs(at.oldLineNo - first.oldLineNo) * 2
          : Math.abs((at.newLineNo ?? 0) - (first.newLineNo ?? 0)) * 2 + 1;
      if (dist < bestDist) {
        best = { hunkIdx, start };
        bestDist = dist;
      }
    }
  }
  return best;
}

/** A range group in a commit diff: one hunk of one file, inline rows or one
 *  side-by-side column. */
export type RowSide = "row" | "old" | "new";

export function rowGroup(fileIdx: number, hunkIdx: number, side: RowSide): string {
  return `${fileIdx}:${hunkIdx}:${side}`;
}

export function parseRowGroup(group: string): { fileIdx: number; hunkIdx: number; side: RowSide } {
  const [f, h, side] = group.split(":");
  return { fileIdx: Number(f), hunkIdx: Number(h), side: side as RowSide };
}

/** Rows `lo..hi` of one column of side-by-side pairs, gaps dropped. */
export function rowsInColumn(
  pairs: { left: DiffLine | null; right: DiffLine | null }[],
  side: "old" | "new",
  lo: number,
  hi: number,
): DiffLine[] {
  return pairs
    .slice(lo, hi + 1)
    .map((p) => (side === "old" ? p.left : p.right))
    .filter((l): l is DiffLine => l !== null);
}
