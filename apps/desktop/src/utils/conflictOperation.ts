import type { RepoOperationState } from "./backend";

/** The operations the conflict banner knows how to abort and continue. */
export type ConflictOperation = "merge" | "cherry_pick";

/**
 * Decide which operation the conflict banner is looking at.
 *
 * `isCherryPicking` is a frontend ref set when *this app* starts a cherry-pick.
 * It does not survive opening a repository that is already mid-cherry-pick, so
 * on its own it made the banner offer "Abort merge" for a cherry-pick and the
 * post-resolution chain run `git merge --continue` where no MERGE_HEAD exists.
 * `gitRepoState` reads the repository itself (MERGE_HEAD / CHERRY_PICK_HEAD /
 * …), so when it knows, it decides.
 *
 * @param diskState what `gitRepoState` reported, or null when the call failed.
 * @param isCherryPicking `useGitRepo`'s flag — the fallback, and still correct
 *   when the app just started the cherry-pick and the disk read has not landed.
 * @returns "cherry_pick" or "merge". A `revert` maps to "merge": the app has no
 *   `git revert --abort` wrapper, so this preserves today's behaviour instead
 *   of offering a button that cannot work.
 */
export function resolveConflictOperation(
  diskState: RepoOperationState["state"] | null,
  isCherryPicking: boolean,
): ConflictOperation {
  if (diskState === "cherry_pick") return "cherry_pick";
  if (diskState === "merge" || diskState === "revert") return "merge";
  // "clean", a rebase (the rebase banner owns that case), or an unreadable
  // state: nothing authoritative, so the frontend flag is all we have.
  return isCherryPicking ? "cherry_pick" : "merge";
}
