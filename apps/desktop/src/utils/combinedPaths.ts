/**
 * The names to give git for a combined diff opened from a file's history
 * (v3.15). Pure; used by `FileHistoryViewer`.
 */
import type { FileLineageEntry, FileLogEntry } from "./backend";

/**
 * `selected`: the chosen versions; `fullLog`: the file's complete, unfiltered
 * `--follow` lineage (`getGitFileLineage`), newest first; `filePath`: the
 * viewed file. The lineage must see every rename, hence the whole history.
 *
 * Range results and merges carry no `path`: it is resolved by hash from the
 * lineage; an entry still unnamed gets every name the file has had (a
 * superset within this file's lineage is correct, a missing name is not).
 * Rename pairing: every name between the oldest and newest selected entries,
 * plus the name of the first named entry before the oldest (a merge in
 * between carries none) — always added: when the oldest is a rename commit
 * it is the old name `-M` needs to pair it, otherwise it is the same name
 * (harmless). Older entries all unnamed: every name of the lineage.
 */
export function combinedPathsFor(
  selected: readonly FileLogEntry[],
  fullLog: readonly FileLineageEntry[],
  filePath: string,
): string[] {
  const known = new Map(fullLog.map((x) => [x.hash, x.path]));
  const lineage = [...new Set([filePath, ...fullLog.flatMap((x) => (x.path ? [x.path] : []))])];
  const names = new Set<string>([filePath]);
  for (const x of selected) {
    const p = x.path ?? known.get(x.hashFull);
    if (p) names.add(p);
    else lineage.forEach((n) => names.add(n));
  }
  const idx = selected.map((x) => fullLog.findIndex((f) => f.hash === x.hashFull)).filter((i) => i >= 0);
  if (idx.length) {
    const newest = Math.min(...idx);
    const oldest = Math.max(...idx);
    for (let i = newest; i <= oldest; i++) {
      const p = fullLog[i].path;
      if (p) names.add(p);
    }
    // The name before the oldest: the first named entry past it (a merge
    // carries no `path`); all pathless, every name the file has had.
    const before = fullLog.slice(oldest + 1);
    const named = before.find((x) => x.path)?.path;
    if (named) names.add(named);
    else if (before.length) lineage.forEach((n) => names.add(n));
  }
  return [...names];
}
