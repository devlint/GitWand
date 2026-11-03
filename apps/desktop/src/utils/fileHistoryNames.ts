import type { FileLogEntry } from "./backend";

type Lists = readonly (readonly FileLogEntry[] | null | undefined)[];

/** The name an entry carries itself, in the history or an extra list (pickaxe). */
function ownName(hash: string, history: readonly FileLogEntry[], extra: Lists): string | undefined {
  for (const list of [history, ...extra]) {
    const own = list?.find((e) => e.hashFull === hash)?.path;
    if (own !== undefined) return own;
  }
  return undefined;
}

/**
 * The file's repo-root-relative name at `hash`, for the history compare.
 *
 * `history` is the loaded `--follow` log, newest first; `extra` holds other
 * results that may carry names of their own (pickaxe). An entry's own `path`
 * wins. An unnamed entry that is *in* the loaded history (a merge commit)
 * takes the name of the nearest older named entry — the name a commit sees is
 * the one the last change at or before it left, and a rename is a change —
 * else the nearest newer one, by list order.
 *
 * A commit outside the loaded history (a line-range result older than what
 * was loaded) is not guessed at: `undefined`, and the backend uses the
 * current path. `isNameUnknown` tells the caller so it can explain a
 * "not found" that follows.
 */
export function nameAtCommit(
  hash: string,
  history: readonly FileLogEntry[],
  extra: Lists = [],
): string | undefined {
  const own = ownName(hash, history, extra);
  if (own !== undefined) return own;
  const at = history.findIndex((e) => e.hashFull === hash);
  if (at === -1) return undefined;
  for (let i = at + 1; i < history.length; i++) {
    const p = history[i]!.path;
    if (p !== undefined) return p;
  }
  for (let i = at - 1; i >= 0; i--) {
    const p = history[i]!.path;
    if (p !== undefined) return p;
  }
  return undefined;
}

/**
 * True when nothing loaded says what the file was called at `hash`: no entry
 * names it, and it is either outside the loaded history or an unnamed entry
 * with no named neighbour. The compare then runs with the current path,
 * which a rename further back would not match.
 */
export function isNameUnknown(
  hash: string,
  history: readonly FileLogEntry[],
  extra: Lists = [],
): boolean {
  return nameAtCommit(hash, history, extra) === undefined;
}
