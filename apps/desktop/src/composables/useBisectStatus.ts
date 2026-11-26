/**
 * The bisect in progress, for BisectBanner (design:
 * docs/superpowers/specs/2026-11-26-guided-bisect-design.md): reads it with
 * `gitBisectStatus` whenever `cwd` or `refreshKey` changes, and drives it
 * with Good / Bad / Skip / Continue and End bisect.
 *
 * Only the banner imports it, so it stays in the banner's lazy chunk.
 */
import { computed, ref, watch } from "vue";
import {
  gitBisectMark,
  gitBisectReset,
  gitBisectStatus,
  type BisectStatus,
  type BisectVerdict,
} from "../utils/backend";
import { bisectErrorMessage } from "./bisectError";

export function useBisectStatus(opts: {
  cwd: () => string;
  /** Any value that changes when the bisect may have moved. */
  refreshKey: () => unknown;
  /** The bisect moved (marked, ended), or may have: the caller reloads repo state and log. */
  onChanged: () => void;
}) {
  const status = ref<BisectStatus | null>(null);
  const busy = ref(false);
  const error = ref("");

  // Only the latest load applies: an older one (a previous repo, an earlier
  // key) finishing last must not overwrite it.
  let loadRequest = 0;
  async function load(keepError = false) {
    const request = ++loadRequest;
    try {
      const next = await gitBisectStatus(opts.cwd());
      if (request !== loadRequest) return;
      // Ended (in a terminal) before the repo state caught up: nothing to show.
      status.value = next.active ? next : null;
      if (!keepError || !next.active) error.value = "";
    } catch (e) {
      if (request !== loadRequest) return;
      error.value = bisectErrorMessage(e);
    }
  }

  watch(() => [opts.cwd(), opts.refreshKey()], () => load(), { immediate: true });

  const culprit = computed(() =>
    status.value && status.value.candidates.length === 1 ? status.value.candidates[0] : null,
  );
  const candidates = computed(() =>
    status.value && status.value.candidates.length > 1 ? status.value.candidates : [],
  );
  const narrowing = computed(() => !culprit.value && candidates.value.length === 0);
  const pending = computed(() => narrowing.value && !!status.value?.pendingCheckout);
  /** [bad, good] when the bisect set its own terms (`--term-old/--term-new`). */
  const customTerms = computed(() => {
    const terms = status.value?.terms;
    return terms && (terms[0] !== "bad" || terms[1] !== "good") ? terms : null;
  });

  /** What the banner knows of a commit (subject, author, date), if anything. */
  const info = (hash: string | null | undefined) =>
    (hash && status.value?.commits.find((c) => c.hash === hash)) || null;

  async function act(run: () => Promise<BisectStatus | void>) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    // Another repo opened meanwhile (the banner stays mounted): its result
    // is not this repo's. A load started meanwhile is at least as fresh.
    const cwd = opts.cwd();
    const request = ++loadRequest;
    try {
      const next = await run();
      if (opts.cwd() !== cwd) return;
      if (next && request === loadRequest) status.value = next.active ? next : null;
      opts.onChanged();
    } catch (e) {
      if (opts.cwd() !== cwd) return;
      error.value = bisectErrorMessage(e);
      // git may have recorded the mark before failing (a checkout refused by
      // uncommitted changes): show what it holds now, keeping the error.
      await load(true);
      opts.onChanged();
    } finally {
      busy.value = false;
    }
  }

  const mark = (verdict: BisectVerdict) => act(() => gitBisectMark(opts.cwd(), verdict));
  const end = () => act(() => gitBisectReset(opts.cwd()));

  return { status, busy, error, culprit, candidates, narrowing, pending, customTerms, info, mark, end };
}
