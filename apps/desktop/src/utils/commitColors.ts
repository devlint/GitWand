/**
 * Colour of the `idx`-th commit of a combined diff. The 8 `--combined-c0..7`
 * variables are defined once, for both themes, on `.combined-palette` in
 * `assets/combined-palette.css`: an element using this colour must sit under
 * that class. Past 8 commits the colours repeat: every marker's title and
 * every chip names the commit's short hash, and the combined view's header
 * says so (`combined.colorsRepeat`).
 */
export function commitColor(idx: number): string {
  return `var(--combined-c${((idx % 8) + 8) % 8})`;
}
