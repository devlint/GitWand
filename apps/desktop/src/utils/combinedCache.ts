/**
 * The last combined-diff result (v3.15), kept at module level: the view
 * remounts when the user leaves the Git Tree and comes back, and a replay can
 * cost hundreds of git spawns. Reused only for the same repository and
 * request; another repository drops it. It can weigh up to the 16 MB payload
 * budget, so App clears it as soon as the combined view is closed or the
 * repository changes. A small module of its own: App imports it eagerly,
 * the rest of the combined view stays in its lazy chunk.
 */
import type { CombinedDiff } from "./backend";

/** The request shape of `useCombinedDiff` (structural, to stay import-light). */
interface CombinedRequestKey {
  hashes: string[];
  paths?: string[];
}

const keyOf = (req: CombinedRequestKey) => JSON.stringify([req.hashes, req.paths ?? null]);

/** A one-entry cache of the last result. Pure. */
export function combinedResultCache() {
  let last: { cwd: string; key: string; data: CombinedDiff } | null = null;
  return {
    /** The stored result for this repo and request; another repo drops it. */
    get(cwd: string, req: CombinedRequestKey): CombinedDiff | null {
      if (last && last.cwd !== cwd) last = null;
      return last && last.key === keyOf(req) ? last.data : null;
    },
    set(cwd: string, req: CombinedRequestKey, data: CombinedDiff) {
      last = { cwd, key: keyOf(req), data };
    },
    clear() {
      last = null;
    },
  };
}

/** The cache `useCombinedDiff` reads and fills. */
export const combinedCache = combinedResultCache();

/** Drops the kept result (combined view closed, repository changed). */
export function clearCombinedCache(): void {
  combinedCache.clear();
}
