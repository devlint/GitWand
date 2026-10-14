import type { FileLogEntry } from "./backend";

/**
 * The file's repo-root-relative name at `hash`, for the history compare.
 *
 * `history` is the loaded `--follow` log, newest first; `extra` holds other
 * results that may carry names of their own (pickaxe). An entry's own `path`
 * wins. An entry without one — a merge commit, or a line-range result, whose
 * `git log -L` cannot list names — takes the name of the nearest *older*
 * named entry in the history: the name a commit sees is the one the last
 * change at or before it left, and a rename is a change. With nothing older,
 * the nearest newer one. A commit absent from the history is placed by its
 * date. `undefined` only when nothing in the history is named, and the
 * backend then uses the current path.
 */
export function nameAtCommit(
  hash: string,
  history: readonly FileLogEntry[],
  extra: readonly (readonly FileLogEntry[] | null | undefined)[] = [],
): string | undefined {
  for (const list of [history, ...extra]) {
    const own = list?.find((e) => e.hashFull === hash)?.path;
    if (own !== undefined) return own;
  }

  let at = history.findIndex((e) => e.hashFull === hash);
  if (at === -1) {
    // Not in the loaded history: slot it in by date, among entries newest first.
    const entry = extra.flatMap((l) => l ?? []).find((e) => e.hashFull === hash);
    const when = entry ? Date.parse(entry.date) : NaN;
    if (Number.isNaN(when)) return undefined;
    const older = history.findIndex((e) => Date.parse(e.date) <= when);
    at = older === -1 ? history.length : older - 0.5;
  }
  for (let i = Math.ceil(at); i < history.length; i++) {
    const p = history[i]!.path;
    if (p !== undefined) return p;
  }
  for (let i = Math.floor(at); i >= 0; i--) {
    const p = history[i]?.path;
    if (p !== undefined) return p;
  }
  return undefined;
}
