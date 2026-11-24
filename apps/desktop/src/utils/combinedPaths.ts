/**
 * The names to give git for a combined diff opened from a file's history
 * (v3.15). Pure; used by `FileHistoryViewer`.
 */
import type { FileLogEntry } from "./backend";

/**
 * `selected`: the chosen versions; `fullLog`: the file's unfiltered
 * `--follow` log, newest first; `filePath`: the viewed file.
 *
 * Range results and merges carry no `path`: it is resolved by hash from the
 * full log; an entry still unnamed gets every name the file has had (a
 * superset within this file's lineage is correct, a missing name is not).
 * Rename pairing: every name between the oldest and newest selected entries,
 * plus the name of the entry just before the oldest — always added: when the
 * oldest is a rename commit it is the old name `-M` needs to pair it,
 * otherwise it is the same name (harmless).
 */
export function combinedPathsFor(
  selected: readonly FileLogEntry[],
  fullLog: readonly FileLogEntry[],
  filePath: string,
): string[] {
  const known = new Map(fullLog.map((x) => [x.hashFull, x.path]));
  const lineage = [...new Set([filePath, ...fullLog.flatMap((x) => (x.path ? [x.path] : []))])];
  const names = new Set<string>([filePath]);
  for (const x of selected) {
    const p = x.path ?? known.get(x.hashFull);
    if (p) names.add(p);
    else lineage.forEach((n) => names.add(n));
  }
  const idx = selected.map((x) => fullLog.findIndex((f) => f.hashFull === x.hashFull)).filter((i) => i >= 0);
  if (idx.length) {
    const newest = Math.min(...idx);
    const oldest = Math.max(...idx);
    for (let i = newest; i <= oldest; i++) {
      const p = fullLog[i].path;
      if (p) names.add(p);
    }
    const before = fullLog[oldest + 1]?.path;
    if (before) names.add(before);
  }
  return [...names];
}
