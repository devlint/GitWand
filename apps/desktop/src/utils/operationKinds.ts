/**
 * What each in-progress operation (`git_repo_state`) means for the app.
 *
 * A bisect is not a paused rebase or merge: nothing to continue or abort,
 * no halted commit to split, and it can stay open for hours, so it has its
 * own banner (`BisectBanner`) and is polled only while the watcher cannot
 * refresh it (its repo state spawns no process).
 */
import type { RepoChangeEvent, RepoOperationState } from "./backend";

export function isBisect(op: RepoOperationState | null): boolean {
  return op?.state === "bisect";
}

/**
 * Whether the 3 s repo-state poll runs for this operation. A bisect is
 * polled only while the watcher is down (turned off, network mount, error):
 * a terminal mark that leaves HEAD in place changes no `git status` output,
 * so the status poll would not catch it.
 */
export function pollsRepoState(op: RepoOperationState | null, watcherHealthy = false): boolean {
  return op !== null && (!isBisect(op) || !watcherHealthy);
}

/**
 * Whether a watcher event can move a bisect: HEAD, the BISECT_* files, or a
 * ref under `refs/bisect/` (packed or reftable refs too). Not a fetch that
 * only moves `refs/remotes/*`, nor a branch or tag update.
 */
export function movesBisect(ev: RepoChangeEvent): boolean {
  if (ev.truncated || ev.kinds.includes("head") || ev.kinds.includes("mergeState")) return true;
  return ev.paths.some(
    (p) => p.includes("refs/bisect/") || p.endsWith("packed-refs") || p.includes("reftable/"),
  );
}

/** Whether the Continue/Skip/Abort operation banner applies. */
export function showsOperationBanner(op: RepoOperationState | null): boolean {
  return op !== null && !isBisect(op);
}
