/**
 * useConflictEditorSelection — whether the Changes view shows the merge
 * editor for the selected file.
 *
 * Selecting a conflicted file loads the repo's conflicts first, which takes
 * a few hundred milliseconds. `showing` only turns on once they are loaded,
 * so `pending` covers the gap: without it the view fell back to the plain
 * diff of the raw conflict markers, "Stage this hunk" included.
 *
 * Each selection supersedes the previous one. A load that finishes after the
 * selection moved on, to a clean file or to another conflict, is dropped,
 * instead of opening the merge editor on whatever is selected by then.
 */
import { ref, watch, type Ref } from "vue";

export interface ConflictEditorSelectionOptions {
  isConflicted: Readonly<Ref<boolean>>;
  filePath: Readonly<Ref<string | null>>;
  repoPath: Readonly<Ref<string | null>>;
  /** Load the repo's conflicts into the merge engine. */
  openConflicts: (repoPath: string) => Promise<void>;
  /** Point the merge engine at one of the loaded files. */
  selectConflict: (filePath: string) => void;
}

export function useConflictEditorSelection(opts: ConflictEditorSelectionOptions) {
  const showing = ref(false);
  const pending = ref(false);
  let generation = 0;

  // Both the flag and the path: switching between two conflicted files keeps
  // `isConflicted` true, so the path change has to trigger on its own.
  watch([opts.isConflicted, opts.filePath], async ([isConflicted, filePath]) => {
    const mine = ++generation;
    const repo = opts.repoPath.value;
    if (!isConflicted || !repo || !filePath) {
      pending.value = false;
      showing.value = false;
      return;
    }
    pending.value = true;
    try {
      await opts.openConflicts(repo);
    } catch {
      if (mine === generation) {
        pending.value = false;
        showing.value = false;
      }
      return;
    }
    if (mine !== generation) return;
    opts.selectConflict(filePath);
    pending.value = false;
    showing.value = true;
  });

  return { showing, pending };
}
