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

/**
 * Whether `ancestor` is in the history of `descendant`, walking the parents
 * of the loaded log only: `true` when reached, `false` when every path ends
 * at a root commit without it, `null` when a path leaves the loaded log (the
 * backend decides then).
 */
export function inLoadedHistoryOf(
  log: readonly { hashFull: string; parents: readonly string[] }[],
  ancestor: string,
  descendant: string,
): boolean | null {
  const byHash = new Map(log.map((e) => [e.hashFull, e]));
  const seen = new Set<string>();
  const stack = [descendant];
  let unknown = false;
  while (stack.length) {
    const h = stack.pop()!;
    if (h === ancestor) return true;
    if (seen.has(h)) continue;
    seen.add(h);
    const e = byHash.get(h);
    if (!e) {
      unknown = true;
      continue;
    }
    stack.push(...e.parents);
  }
  return unknown ? null : false;
}
