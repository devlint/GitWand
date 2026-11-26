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
  /** The last read's error: cleared by the next read that succeeds. */
  const loadError = ref("");
  /**
   * The last action's error (git refused a checkout, say): kept through the
   * reloads it causes (a refused checkout still records the mark, which
   * moves the mark count and reloads), until the next action, another repo,
   * or the bisect moving on (a `git bisect next` in a terminal).
   */
  const actionError = ref("");
  /** Where the bisect stood when `actionError` was set; null while setting it. */
  let errorAt: string | null = null;
  const position = (st: BisectStatus) =>
    `${st.current}:${st.pendingCheckout}:${st.candidates.length}:${st.good.length}:${st.skipped.length}`;
  const error = computed(() => actionError.value || loadError.value);

  // Only the latest load applies: an older one (a previous repo, an earlier
  // key) finishing last must not overwrite it.
  let loadRequest = 0;
  async function load() {
    const request = ++loadRequest;
    try {
      const next = await gitBisectStatus(opts.cwd());
      if (request !== loadRequest) return;
      // Ended (in a terminal) before the repo state caught up: nothing to show.
      status.value = next.active ? next : null;
      loadError.value = "";
      if (!next.active || (errorAt !== null && position(next) !== errorAt)) {
        actionError.value = "";
        errorAt = null;
      }
    } catch (e) {
      if (request !== loadRequest) return;
      loadError.value = bisectErrorMessage(e);
    }
  }

  // Watcher ticks, HEAD and the mark count often change together (each
  // action moves all three): a trigger while a load runs asks for one more
  // load after it, not one each.
  let loading = false;
  let again = false;
  function reload() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    void load().finally(() => {
      loading = false;
      if (again) {
        again = false;
        reload();
      }
    });
  }

  watch(
    () => opts.cwd(),
    () => {
      // Another repo: nothing of the previous one stays on screen, even when
      // this one's read fails, and a read still running for it is dropped.
      loadRequest++;
      status.value = null;
      loadError.value = "";
      actionError.value = "";
      errorAt = null;
    },
  );
  watch(() => [opts.cwd(), opts.refreshKey()], reload, { immediate: true });

  const culprit = computed(() =>
    status.value && status.value.candidates.length === 1 ? status.value.candidates[0] : null,
  );
  const candidates = computed(() =>
    status.value && status.value.candidates.length > 1 ? status.value.candidates : [],
  );
  const narrowing = computed(() => !culprit.value && candidates.value.length === 0);
  const pending = computed(() => narrowing.value && !!status.value?.pendingCheckout);
  /** git has nothing left to test and no culprit (the paths match no commit left, say). */
  const noResult = computed(
    () => narrowing.value && !pending.value && status.value?.remaining === 0,
  );
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
    actionError.value = "";
    errorAt = null;
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
      actionError.value = bisectErrorMessage(e);
      errorAt = null;
      // git may have recorded the mark before failing (a checkout refused by
      // uncommitted changes): show what it holds now, with the error, which
      // stays until the bisect moves from there.
      await load();
      if (opts.cwd() === cwd && status.value) errorAt = position(status.value);
      opts.onChanged();
    } finally {
      busy.value = false;
    }
  }

  const mark = (verdict: BisectVerdict) => act(() => gitBisectMark(opts.cwd(), verdict));
  const end = () => act(() => gitBisectReset(opts.cwd()));

  return { status, busy, error, culprit, candidates, narrowing, pending, noResult, customTerms, info, mark, end };
}
