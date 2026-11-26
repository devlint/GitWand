/**
 * What each in-progress operation (`git_repo_state`) means for the app.
 *
 * A bisect is not a paused rebase or merge: nothing to continue or abort,
 * no halted commit to split, and it can stay open for hours, so it has its
 * own banner (`BisectBanner`) and no 3 s poll (the watcher and its own
 * actions refresh it).
 */
import type { RepoOperationState } from "./backend";

export function isBisect(op: RepoOperationState | null): boolean {
  return op?.state === "bisect";
}

/** Whether the 3 s repo-state poll runs for this operation. */
export function pollsRepoState(op: RepoOperationState | null): boolean {
  return op !== null && !isBisect(op);
}

/** Whether the Continue/Skip/Abort operation banner applies. */
export function showsOperationBanner(op: RepoOperationState | null): boolean {
  return op !== null && !isBisect(op);
}
