/**
 * Populates a SCRATCH git index file with the contents of `treeOid` (a tree
 * object — typically the output of `git merge-tree --write-tree`), scoped to
 * `repo`. Never touches `repo`'s own index: `GIT_INDEX_FILE` redirects git's
 * plumbing to `indexPath` for this one call only. The caller later points
 * `checkout-index --work-tree=<dir>` at the same `indexPath` (via
 * `GIT_INDEX_FILE`) to materialize the tree's files into a disposable
 * worktree — see `scripts/replay-regenerate.mjs` and
 * `packages/cli/src/regenerate-runner.ts`'s `addWorktree`.
 */
import { execFileSync } from "node:child_process";

export function seedScratchIndex(repo, treeOid, indexPath) {
  execFileSync("git", ["-C", repo, "read-tree", treeOid], {
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
  });
}
