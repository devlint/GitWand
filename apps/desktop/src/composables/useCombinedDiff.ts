/**
 * Loads the combined diff of a request (2+ commits, optional path filter)
 * and derives the entries `CommitDiffViewer` renders. A response that
 * arrives after the request changed (or after a reload) is dropped.
 *
 * The last successful result is kept at module level: the view remounts when
 * the user leaves the Git Tree and comes back, and a replay can cost hundreds
 * of git spawns. It is reused only for the same repository, request and
 * fetcher; another repository drops it, `reload()` bypasses and replaces it.
 */
import { computed, ref, watch, type Ref } from "vue";
import { getCombinedDiff, type CombinedDiff } from "../utils/backend";
import { buildCombinedEntries } from "../utils/combinedAttribution";

export interface CombinedRequest {
  hashes: string[];
  /** Limit the diff to these paths (file-history entry point). */
  paths?: string[];
}

let last: { cwd: string; key: string; fetcher: typeof getCombinedDiff; data: CombinedDiff } | null = null;

const keyOf = (req: CombinedRequest) => JSON.stringify([req.hashes, req.paths ?? null]);

export function useCombinedDiff(
  cwd: Ref<string>,
  request: Ref<CombinedRequest | null>,
  fetcher: typeof getCombinedDiff = getCombinedDiff,
) {
  const data = ref<CombinedDiff | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let token = 0;

  async function load(force = false) {
    const my = ++token;
    const req = request.value;
    const repo = cwd.value;
    data.value = null;
    error.value = null;
    if (last && last.cwd !== repo) last = null;
    if (!req) {
      loading.value = false;
      return;
    }
    const key = keyOf(req);
    if (!force && last && last.key === key && last.fetcher === fetcher) {
      data.value = last.data;
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const result = await fetcher(repo, req.hashes, req.paths);
      if (my !== token) return;
      data.value = result;
      last = { cwd: repo, key, fetcher, data: result };
    } catch (e) {
      if (my !== token) return;
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (my === token) loading.value = false;
    }
  }

  watch([cwd, request], () => load(), { immediate: true });

  const entries = computed(() => (data.value ? buildCombinedEntries(data.value) : []));

  return { data, entries, loading, error, reload: () => void load(true) };
}
