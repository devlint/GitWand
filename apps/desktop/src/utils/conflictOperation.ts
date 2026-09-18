import type { OperationKind, RepoOperationState } from "./backend";

// The operation union has one definition, `OperationKind` in backend.ts, so
// the composable and this helper cannot drift apart.

/**
 * Name the operation the repository is in, or null when there is none.
 *
 * The repository is the only source. #201 replaced the `isCherryPicking`
 * frontend flag with this read — the flag was set when *this app* started a
 * cherry-pick and so did not survive opening a repo that was already
 * mid-cherry-pick — and this change removed the flag entirely, so there is no
 * longer a second answer to fall back to.
 */
export function resolveConflictOperation(
  diskState: RepoOperationState["state"] | null,
): OperationKind | null {
  switch (diskState) {
    case "merge":
    case "cherry_pick":
    case "revert":
    case "rebase":
      return diskState;
    // An interactive rebase is still a rebase as far as continue/abort/skip go.
    case "rebase_interactive":
      return "rebase";
    default:
      return null;
  }
}
