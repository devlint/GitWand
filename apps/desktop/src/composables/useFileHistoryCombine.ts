/**
 * Opening a combined diff from a file's history (v3.15): the busy / error
 * state, the file's complete `--follow` lineage fetched at open time
 * (`getGitFileLineage`: the 50 loaded entries can miss an older rename, or
 * the name before a rename commit that is the 50th entry — a partial net
 * diff), its names through `combinedPathsFor`, and the guard that drops a
 * reply for a file the viewer no longer shows.
 *
 * Errors are shown localized (`combinedErrorMessage`).
 *
 * The selection is the viewer's (`useCommitSelection`, keyed per file). The
 * combined diff opens with the selection as it is once the lineage is in
 * (the user may change it meanwhile) — nothing if fewer than two remain —
 * and clears it only if it did not change since the click. A file the viewer
 * leaves (another file shown, or the viewer gone) loses its selection, so
 * the file histories one opens do not leave a state each.
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { FileLineageEntry, FileLogEntry } from "../utils/backend";
import type { CombinedRequest } from "./useCombinedDiff";
import { COMBINE_MAX, forgetSelection, type useCommitSelection } from "./useCommitSelection";
import { combinedPathsFor } from "../utils/combinedPaths";
import { combinedErrorMessage, rawErrorText } from "../utils/combinedError";
import { useI18n } from "./useI18n";

export function useFileHistoryCombine(opts: {
  cwd: Readonly<Ref<string>>;
  filePath: Readonly<Ref<string>>;
  /** The key `selection` is stored under (repo + file). */
  selectionKey: Readonly<Ref<string>>;
  selection: ReturnType<typeof useCommitSelection>;
  /** The log entries the selection was made in (the displayed list). */
  displayedLog: Readonly<Ref<readonly FileLogEntry[]>>;
  /** The file's complete `--follow` lineage (`getGitFileLineage`). */
  loadLineage: (cwd: string, path: string) => Promise<FileLineageEntry[]>;
  onOpen: (req: CombinedRequest) => void;
}) {
  const { t } = useI18n();
  const busy = ref(false);
  const error = ref<string | null>(null);
  const { selection } = opts;
  const snapshot = () => selection.selected.value.join("\0");

  async function open() {
    if (!selection.canCombine.value || busy.value) return;
    const clicked = snapshot();
    const cwd = opts.cwd.value;
    const file = opts.filePath.value;
    const current = () => opts.cwd.value === cwd && opts.filePath.value === file;
    busy.value = true;
    error.value = null;
    try {
      const lineage = await opts.loadLineage(cwd, file);
      if (!current()) return;
      // The selection as it is now, in the displayed order.
      const set = new Set(selection.selected.value);
      const chosen = opts.displayedLog.value.filter((x) => set.has(x.hashFull));
      if (chosen.length < 2 || chosen.length > COMBINE_MAX) return;
      const paths = combinedPathsFor(chosen, lineage, file);
      opts.onOpen({ hashes: chosen.map((x) => x.hashFull), paths });
      if (snapshot() === clicked) selection.clear();
    } catch (err: unknown) {
      // The lineage's errors in the user's language (unknown ones as is).
      if (current()) error.value = combinedErrorMessage(rawErrorText(err), t);
    } finally {
      busy.value = false;
    }
  }

  // Another file: its error is not this one's, its selection goes.
  watch([opts.cwd, opts.filePath], () => {
    error.value = null;
  });
  watch(opts.selectionKey, (_, previous) => forgetSelection(previous));

  onScopeDispose(() => selection.clear());

  return { busy, error, open };
}
