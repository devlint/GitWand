/**
 * Loads the combined diff of a request (2+ commits, optional path filter)
 * and derives the entries `CommitDiffViewer` renders. A response that
 * arrives after the request changed (or after a reload) is dropped
 * (`latestOnly`), and so is one arriving after the view closed (scope
 * disposed): it must not refill the cache App has just cleared.
 *
 * The last successful result is kept at module level (`utils/combinedCache`):
 * the view remounts when the user leaves the Git Tree and comes back. It is
 * reused only for the same repository and request; another repository or a
 * null request drops it, `reload()` bypasses and replaces it, and App clears
 * it when the view closes. The sequence itself is `utils/combinedLoader`.
 */
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { getCombinedDiff, type CombinedDiff } from "../utils/backend";
import { buildCombinedEntries } from "../utils/combinedAttribution";
import { combinedLoader } from "../utils/combinedLoader";
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
  const loader = combinedLoader(
    (repo, req) => getCombinedDiff(repo, req.hashes, req.paths),
    cache,
    (s) => {
      data.value = s.data;
      loading.value = s.loading;
      error.value = s.error;
    },
  );
  onScopeDispose(loader.dispose);

  const load = (force = false) => void loader.load(cwd.value, request.value, force);

  watch([cwd, request], () => load(), { immediate: true });

  const entries = computed(() => (data.value ? buildCombinedEntries(data.value) : []));

  return { data, entries, loading, error, reload: () => load(true) };
}
