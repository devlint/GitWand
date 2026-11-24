/**
 * Opening a combined diff from a file's history (v3.15): the busy / error
 * state, the file's complete `--follow` log fetched at open time (the 50
 * loaded entries can miss an older rename, or the name before a rename
 * commit that is the 50th entry — a partial net diff), its names through
 * `combinedPathsFor`, and the guard that drops a reply for a file the viewer
 * no longer shows.
 *
 * The selection is the viewer's (`useCommitSelection`, keyed per file): it is
 * cleared once the combined diff is requested, and when the viewer goes, so
 * the file histories one opens do not leave a state each.
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { FileLogEntry } from "../utils/backend";
import type { CombinedRequest } from "./useCombinedDiff";
import type { useCommitSelection } from "./useCommitSelection";
import { combinedPathsFor } from "../utils/combinedPaths";

export function useFileHistoryCombine(opts: {
  cwd: Readonly<Ref<string>>;
  filePath: Readonly<Ref<string>>;
  selection: ReturnType<typeof useCommitSelection>;
  /** The log entries the selection was made in (the displayed list). */
  displayedLog: Readonly<Ref<readonly FileLogEntry[]>>;
  /** The file's complete `--follow` log (`getGitFileLog(cwd, path, FULL_FILE_LOG)`). */
  loadFullLog: (cwd: string, path: string) => Promise<FileLogEntry[]>;
  onOpen: (req: CombinedRequest) => void;
}) {
  const busy = ref(false);
  const error = ref<string | null>(null);
  const { selection } = opts;

  async function open() {
    if (!selection.canCombine.value || busy.value) return;
    const set = new Set(selection.selected.value);
    const chosen = opts.displayedLog.value.filter((x) => set.has(x.hashFull));
    const cwd = opts.cwd.value;
    const file = opts.filePath.value;
    const current = () => opts.cwd.value === cwd && opts.filePath.value === file;
    busy.value = true;
    error.value = null;
    try {
      const fullLog = await opts.loadFullLog(cwd, file);
      if (!current()) return;
      const paths = combinedPathsFor(chosen, fullLog, file);
      opts.onOpen({ hashes: chosen.map((x) => x.hashFull), paths });
      selection.clear();
    } catch (err: unknown) {
      if (current()) error.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  }

  // Another file: its error is not this one's.
  watch([opts.cwd, opts.filePath], () => {
    error.value = null;
  });

  onScopeDispose(() => selection.clear());

  return { busy, error, open };
}
