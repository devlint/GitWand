/**
 * The two ends of a bisect started from a Git Tree multi-selection: exactly
 * two commits of the loaded log; the older one (lower in the log) is good,
 * the newer one bad. Ancestry is checked by the backend.
 */
export function bisectEndpoints(
  selected: readonly string[],
  logOrder: readonly string[],
): { good: string; bad: string } | null {
  if (selected.length !== 2 || selected[0] === selected[1]) return null;
  const [i, j] = selected.map((h) => logOrder.indexOf(h));
  if (i < 0 || j < 0) return null;
  return i > j ? { good: selected[0], bad: selected[1] } : { good: selected[1], bad: selected[0] };
}
