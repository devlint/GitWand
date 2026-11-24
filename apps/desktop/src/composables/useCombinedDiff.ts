/**
 * Loads the combined diff of a request (2+ commits, optional path filter)
 * and derives the entries `CommitDiffViewer` renders. A response that
 * arrives after the request changed (or after a reload) is dropped
 * (`latestOnly`).
 *
 * The last successful result is kept at module level (`utils/combinedCache`):
 * the view remounts when the user leaves the Git Tree and comes back. It is
 * reused only for the same repository and request; another repository or a
 * null request drops it, `reload()` bypasses and replaces it, and App clears
 * it when the view closes.
 */
import { computed, ref, watch, type Ref } from "vue";
import { getCombinedDiff, type CombinedDiff } from "../utils/backend";
import { buildCombinedEntries } from "../utils/combinedAttribution";
import { rawErrorText } from "../utils/combinedError";
import { latestOnly } from "../utils/latestOnly";
import { combinedCache as cache } from "../utils/combinedCache";

export interface CombinedRequest {
  hashes: string[];
  /** Limit the diff to these paths (file-history entry point). */
  paths?: string[];
}

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
    if (!req) cache.clear();
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
