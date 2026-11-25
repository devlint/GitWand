/**
 * Keeps only the latest of overlapping async runs: a run that settles after a
 * later one started (or after `cancel()`) reports itself stale, so its result
 * or error never clobbers a fresher state. Pure — no Vue, no backend.
 */
export type Settled<T> =
  | { stale: true }
  | { stale: false; ok: true; value: T }
  | { stale: false; ok: false; error: unknown };

export function latestOnly() {
  let gen = 0;
  return {
    /** Await `p` as the latest run. */
    async settle<T>(p: Promise<T>): Promise<Settled<T>> {
      const my = ++gen;
      try {
        const value = await p;
        return my === gen ? { stale: false, ok: true, value } : { stale: true };
      } catch (error) {
        return my === gen ? { stale: false, ok: false, error } : { stale: true };
      }
    },
    /** Make the in-flight run, if any, stale. */
    cancel() {
      gen++;
    },
  };
}
