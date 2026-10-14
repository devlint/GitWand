import { ref, type Ref } from "vue";
import type { FileLogEntry, GitDiff } from "../utils/backend";
import { isBeyondHistory, nameAtCommit } from "../utils/fileHistoryNames";

/** What a compare needs from the backend; injected so the logic is testable. */
export type FileDiffLoader = (
  cwd: string,
  path: string,
  fromHash: string,
  toHash: string,
  fromPath?: string,
  toPath?: string,
) => Promise<GitDiff>;

export interface UseFileCompareOptions {
  cwd: Readonly<Ref<string | undefined | null>>;
  filePath: Readonly<Ref<string>>;
  /** The loaded `--follow` history, newest first. */
  history: Ref<FileLogEntry[]>;
  /** Other lists whose entries may be selected (pickaxe, line-range results). */
  extra: Readonly<Ref<(FileLogEntry[] | null)[]>>;
  getDiff: FileDiffLoader;
}

/**
 * State of the file history viewer's Compare tab: the two selected commits,
 * the diff, and an error scoped to this tab (a failed compare must not take
 * down blame or the log).
 *
 * `beyondHistory` is set when a selected commit lies outside the loaded
 * history: its name there is unknown, so the backend was given the current
 * path, which a rename further back would not match. The view uses it to
 * explain a "not found" — or an all-added / all-deleted diff — rather than
 * presenting either as the truth.
 */
export function useFileCompare(opts: UseFileCompareOptions) {
  const from = ref<string | null>(null);
  const to = ref<string | null>(null);
  const diff = ref<GitDiff | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(false);
  const beyondHistory = ref(false);
  // A reply for a selection (or file) that has since changed is dropped.
  let requestId = 0;

  function clearResult() {
    requestId++;
    diff.value = null;
    error.value = null;
    beyondHistory.value = false;
    loading.value = false;
  }

  function reset() {
    from.value = null;
    to.value = null;
    clearResult();
  }

  async function load() {
    const cwd = opts.cwd.value;
    if (!from.value || !to.value || !cwd) return;
    clearResult();
    const id = requestId;
    const history = opts.history.value;
    const extra = opts.extra.value;
    const [a, b] = [from.value, to.value];
    beyondHistory.value = isBeyondHistory(a, history, extra) || isBeyondHistory(b, history, extra);
    loading.value = true;
    try {
      const result = await opts.getDiff(
        cwd,
        opts.filePath.value,
        a,
        b,
        nameAtCommit(a, history, extra),
        nameAtCommit(b, history, extra),
      );
      if (id === requestId) diff.value = result;
    } catch (err) {
      if (id === requestId) error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (id === requestId) loading.value = false;
    }
  }

  /** First click picks "from", second picks "to" and loads, a third starts over. */
  function select(hash: string): boolean {
    if (!from.value) {
      from.value = hash;
      clearResult();
      return false;
    }
    if (!to.value) {
      to.value = hash;
      void load();
      return true;
    }
    from.value = hash;
    to.value = null;
    clearResult();
    return false;
  }

  return { from, to, diff, error, loading, beyondHistory, select, load, reset };
}
