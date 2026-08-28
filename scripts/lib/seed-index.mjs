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
 *
 * Regenerate-sweep re-run #2 fix — `git update-index --force-remove`, even
 * though it only ever edits an index file and never touches the filesystem,
 * is still subject to git's `NEED_WORK_TREE` plumbing rule and fails with
 * `fatal: this operation must be run in a work tree` against a BARE repo —
 * exactly the shape `benchmark/run.mjs`'s `prepare()` clones the corpus into.
 * Since a "runnable" regeneration candidate is BY DEFINITION one whose
 * lockfile is still conflicted, `skipPaths` is non-empty on every real
 * candidate, so this fired 100% of the time against the real corpus. Fixed
 * by building the filtered tree via pure object-database plumbing instead —
 * `git ls-tree -r` + `git mktree` (both never require a work tree, unlike
 * `update-index`) to construct a tree object with the skipped paths already
 * removed, then a single `git read-tree` of that tree. No work tree is
 * needed anywhere in this function now.
 *
 * Second finding, caught only by testing against a REAL corpus repo
 * (prettier/prettier) rather than trusting the plan's own description: an
 * earlier version of this fix rebuilt the ENTIRE tree from a flat `git
 * ls-tree -r` (thousands of entries even for one lockfile skip, since
 * prettier's tree alone has 3000+ directories) and fed it straight to `git
 * mktree`. Two problems, both only visible against a real tree: (1) `mktree`
 * does not reconstruct nested subtrees from full recursive paths on its own —
 * it rejects any entry whose name contains a slash with `fatal: path ...
 * contains slash`; (2) without `-z`, both `ls-tree` and `mktree` use
 * C-style quoting for filenames with special characters (spaces, quotes,
 * unicode — common in any large real repo's test fixtures), and reassembling
 * quoted names by hand (e.g. splitting a quoted, escaped path on `/`) breaks
 * in ways that surface as `fatal: invalid quoting`.
 *
 * Fixed by doing dramatically less work, correctly: since `skipPaths` is
 * always a small, known set of exact paths (the merge's own conflicted
 * files), only the directories on the path from the root to each skipped
 * file actually change — every sibling subtree keeps its ORIGINAL oid
 * untouched. `removePathFromTree` walks that one chain per skip path with
 * `git ls-tree -z <tree>` (single level, NOT recursive) and rewrites just
 * that level's entries via `git mktree -z`, propagating the new subtree oid
 * up to its parent. `-z` (NUL-terminated, unquoted raw bytes) is used for
 * BOTH commands throughout, which sidesteps the quoting class of bug
 * entirely rather than trying to parse or re-emit quoted names correctly.
 *
 * Third finding, again only visible against the real corpus (not the unit
 * fixtures, which are always full, non-partial clones): `benchmark/run.mjs`'s
 * `prepare()` clones the corpus BLOBLESS (`--filter=blob:none`), so most blob
 * objects at a given historical tree are not fetched locally yet. `git
 * mktree` — unlike most git commands, which lazily fetch a missing object
 * from the partial clone's promisor remote on demand — verifies up front
 * that every object it is asked to reference already exists locally, and
 * does NOT trigger that lazy fetch itself; it fails outright with `fatal:
 * entry '<path>' object <sha> is unavailable`. `--missing` disables that
 * verification. It is safe here specifically because every sha `mktree` is
 * asked to write was read moments earlier from a real `ls-tree` of the same
 * repo's own object database — this function only ever removes an entry, it
 * never invents or mutates a blob/tree sha, so there is nothing to validate.
 */
import { execFileSync } from "node:child_process";

export function seedScratchIndex(repo, treeOid, indexPath, skipPaths = []) {
  let effectiveTreeOid = treeOid;
  for (const path of skipPaths) {
    effectiveTreeOid = removePathFromTree(repo, effectiveTreeOid, path.split("/"));
  }
  execFileSync("git", ["-C", repo, "read-tree", effectiveTreeOid], {
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
  });
}

/**
 * Returns a NEW tree oid equal to `treeOid` with the single path named by
 * `segments` removed, rewriting only the directories on that path — every
 * sibling entry, and every subtree not on the chain, keeps its original oid.
 * `-z` throughout (both `ls-tree` and `mktree`) works on raw, unquoted bytes,
 * so filenames with spaces/quotes/unicode are handled correctly without any
 * hand-rolled quoting logic. Neither command requires or touches a work tree.
 */
function removePathFromTree(repo, treeOid, segments) {
  const [target, ...rest] = segments;
  const output = execFileSync("git", ["-C", repo, "ls-tree", "-z", treeOid], {
    encoding: "utf-8",
  });
  const entries = output.split("\0").filter((entry) => entry.length > 0);

  let targetFound = false;
  const outEntries = [];
  for (const entry of entries) {
    const tabIndex = entry.indexOf("\t");
    const meta = entry.slice(0, tabIndex); // "<mode> <type> <sha>"
    const name = entry.slice(tabIndex + 1);
    if (name !== target) {
      outEntries.push(entry);
      continue;
    }
    targetFound = true;
    if (rest.length === 0) {
      continue; // this is the leaf to remove — drop it, do not re-emit
    }
    const [mode, type, sha] = meta.split(" ");
    const newSubtreeOid = removePathFromTree(repo, sha, rest);
    outEntries.push(`${mode} ${type} ${newSubtreeOid}\t${name}`);
  }

  // Path segment absent at this level (already renamed/removed upstream, or
  // a stale skipPath) — nothing to remove here; the tree is unchanged.
  if (!targetFound) return treeOid;

  const input = outEntries.length > 0 ? outEntries.join("\0") + "\0" : "";
  return execFileSync("git", ["-C", repo, "mktree", "-z", "--missing"], {
    input,
    encoding: "utf-8",
  }).trim();
}
