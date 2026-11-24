/**
 * Loads the combined diff of a request (2+ commits, optional path filter)
 * and derives the entries `CommitDiffViewer` renders. A response that
 * arrives after the request changed (or after a reload) is dropped
 * (`latestOnly`).
 *
 * The last successful result is kept at module level: the view remounts when
 * the user leaves the Git Tree and comes back, and a replay can cost hundreds
 * of git spawns. It is reused only for the same repository and request;
 * another repository drops it, `reload()` bypasses and replaces it.
 */
import { computed, ref, watch, type Ref } from "vue";
import { getCombinedDiff, type CombinedDiff } from "../utils/backend";
import { buildCombinedEntries } from "../utils/combinedAttribution";
import { rawErrorText } from "../utils/combinedError";
import { latestOnly } from "../utils/latestOnly";

export interface CombinedRequest {
  hashes: string[];
  /** Limit the diff to these paths (file-history entry point). */
  paths?: string[];
}

const keyOf = (req: CombinedRequest) => JSON.stringify([req.hashes, req.paths ?? null]);

/** A one-entry cache of the last result. Pure; exported for its tests. */
export function combinedResultCache() {
  let last: { cwd: string; key: string; data: CombinedDiff } | null = null;
  return {
    /** The stored result for this repo and request; another repo drops it. */
    get(cwd: string, req: CombinedRequest): CombinedDiff | null {
      if (last && last.cwd !== cwd) last = null;
      return last && last.key === keyOf(req) ? last.data : null;
    },
    set(cwd: string, req: CombinedRequest, data: CombinedDiff) {
      last = { cwd, key: keyOf(req), data };
    },
  };
}

const cache = combinedResultCache();

export function useCombinedDiff(cwd: Ref<string>, request: Ref<CombinedRequest | null>) {
  const data = ref<CombinedDiff | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const guard = latestOnly();

  async function load(force = false) {
    guard.cancel();
    const req = request.value;
    const repo = cwd.value;
    data.value = null;
    error.value = null;
    const hit = req ? cache.get(repo, req) : null;
    if (!req || (hit && !force)) {
      data.value = hit;
      loading.value = false;
      return;
    }
    loading.value = true;
    const r = await guard.settle(getCombinedDiff(repo, req.hashes, req.paths));
    if (r.stale) return;
    loading.value = false;
    if (r.ok) {
      data.value = r.value;
      cache.set(repo, req, r.value);
    } else {
      error.value = rawErrorText(r.error);
    }
  }

  watch([cwd, request], () => load(), { immediate: true });

  const entries = computed(() => (data.value ? buildCombinedEntries(data.value) : []));

  return { data, entries, loading, error, reload: () => void load(true) };
}
