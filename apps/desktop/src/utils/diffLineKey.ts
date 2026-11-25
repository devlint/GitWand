import type { DiffLine } from "./backend";

/** Which `${side}:${line}` key a diff line is anchored at. Deleted lines
 *  only have an old-side line number (LEFT); added/context lines are keyed
 *  on the new-side line number (RIGHT) — matching the "new-file line
 *  number" convention `usePrPreReview`'s prompt asks the model for.
 *  `null` when the relevant line number is missing. */
export function lineKeyFor(line: DiffLine): string | null {
  if (line.type === "delete") return line.oldLineNo == null ? null : `LEFT:${line.oldLineNo}`;
  return line.newLineNo == null ? null : `RIGHT:${line.newLineNo}`;
}
