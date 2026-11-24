/**
 * Colour of the `idx`-th commit of a combined diff. The 8 `--combined-c0..7`
 * variables are defined once, for both themes, in `CommitDiffViewer.vue`.
 */
export function commitColor(idx: number): string {
  return `var(--combined-c${((idx % 8) + 8) % 8})`;
}
