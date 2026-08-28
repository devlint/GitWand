/**
 * Populates a SCRATCH git index file with the contents of `treeOid` (a tree
 * object — typically the output of `git merge-tree --write-tree`), scoped to
 * `repo`. Never touches `repo`'s own index: `GIT_INDEX_FILE` redirects git's
 * plumbing to `indexPath` for this one call only. The caller later points
 * `checkout-index --work-tree=<dir>` at the same `indexPath` (via
 * `GIT_INDEX_FILE`) to materialize the tree's files into a disposable
 * worktree — see `scripts/replay-regenerate.mjs` and
 * `packages/cli/src/regenerate-runner.ts`'s `addWorktree`.
 *
 * Final review, Critical #1 — `git read-tree <treeOid>` of a SINGLE tree
 * necessarily puts every path in that tree at stage 0, including paths that
 * were genuinely conflicted in the 3-way merge `merge-tree --write-tree`
 * computed `treeOid` from. `merge-tree --write-tree`'s conflicted blobs hold
 * literal diff3 conflict-marker text as their content — so without the
 * `skipPaths` step below, `checkout-index --all` (which only ever skips
 * paths NOT at stage 0) would happily write that marker-laden content into
 * the worktree. Production never does this: a genuine in-progress merge's
 * index holds conflicted paths at stages 1/2/3, and `checkout-index --all`
 * silently skips anything not at stage 0. `skipPaths` (the set of paths this
 * historical merge actually left conflicted, known at candidate-discovery
 * time — see `replay-regenerate.mjs`) removes those paths from the scratch
 * index after the `read-tree`, so the harness's scratch index behaves
 * exactly like production's real multi-stage index: still-conflicted paths
 * are absent, not materialized with marker content.
 */
import { execFileSync } from "node:child_process";

export function seedScratchIndex(repo, treeOid, indexPath, skipPaths = []) {
  execFileSync("git", ["-C", repo, "read-tree", treeOid], {
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
  });
  if (skipPaths.length > 0) {
    execFileSync("git", ["-C", repo, "update-index", "--force-remove", "--", ...skipPaths], {
      env: { ...process.env, GIT_INDEX_FILE: indexPath },
    });
  }
}
