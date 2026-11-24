/**
 * The load sequence behind `useCombinedDiff`, Vue-free: reuse the cached
 * result of the same repository and request, otherwise run the request and
 * keep only the latest one (`latestOnly`). `dispose()` — the view closed —
 * makes the run in flight stale: a replay settling afterwards reaches
 * neither the state nor the cache, which App has just cleared.
 */
import type { CombinedDiff } from "./backend";
import type { combinedResultCache } from "./combinedCache";
import { rawErrorText } from "./combinedError";
import { latestOnly } from "./latestOnly";

/** The request shape of `useCombinedDiff` (structural). */
interface CombinedLoadRequest {
  hashes: string[];
  paths?: string[];
}

export interface CombinedLoadState {
  data: CombinedDiff | null;
  loading: boolean;
  error: string | null;
}

export function combinedLoader(
  run: (cwd: string, req: CombinedLoadRequest) => Promise<CombinedDiff>,
  cache: ReturnType<typeof combinedResultCache>,
  set: (state: CombinedLoadState) => void,
) {
  const guard = latestOnly();
  let disposed = false;

  async function load(cwd: string, req: CombinedLoadRequest | null, force = false): Promise<void> {
    guard.cancel();
    if (disposed) return;
    if (!req) cache.clear();
    const hit = req ? cache.get(cwd, req) : null;
    if (!req || (hit && !force)) {
      set({ data: hit, loading: false, error: null });
      return;
    }
    set({ data: null, loading: true, error: null });
    const r = await guard.settle(run(cwd, req));
    if (r.stale || disposed) return;
    if (r.ok) {
      cache.set(cwd, req, r.value);
      set({ data: r.value, loading: false, error: null });
    } else {
      set({ data: null, loading: false, error: rawErrorText(r.error) });
    }
  }

  return {
    load,
    /** The view closed: the run in flight, if any, is dropped. */
    dispose() {
      disposed = true;
      guard.cancel();
    },
  };
}
