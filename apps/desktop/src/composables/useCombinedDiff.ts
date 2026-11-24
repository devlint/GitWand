/**
 * Loads the combined diff of a request (2+ commits, optional path filter)
 * and derives the entries `CommitDiffViewer` renders. A response that
 * arrives after the request changed (or after a reload) is dropped.
 */
import { computed, ref, watch, type Ref } from "vue";
import { getCombinedDiff, type CombinedDiff } from "../utils/backend";
import { buildCombinedEntries } from "../utils/combinedAttribution";

export interface CombinedRequest {
  hashes: string[];
  /** Limit the diff to these paths (file-history entry point). */
  paths?: string[];
}

export function useCombinedDiff(
  cwd: Ref<string>,
  request: Ref<CombinedRequest | null>,
  fetcher: typeof getCombinedDiff = getCombinedDiff,
) {
  const data = ref<CombinedDiff | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let token = 0;

  async function load() {
    const my = ++token;
    const req = request.value;
    data.value = null;
    error.value = null;
    if (!req) {
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const result = await fetcher(cwd.value, req.hashes, req.paths);
      if (my !== token) return;
      data.value = result;
    } catch (e) {
      if (my !== token) return;
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (my === token) loading.value = false;
    }
  }

  watch([cwd, request], load, { immediate: true });

  const entries = computed(() => (data.value ? buildCombinedEntries(data.value) : []));

  return { data, entries, loading, error, reload: () => void load() };
}
