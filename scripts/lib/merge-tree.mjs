/**
 * mergeTree(repo, p1, p2) — thin wrapper around `git merge-tree --write-tree`
 * (diff3 conflict style), extracted out of `scripts/replay-regenerate.mjs`'s
 * stage-1 candidate discovery so it can be unit-tested against real hermetic
 * git repos. Returns `null` on a clean merge (exit 0 — no lockfile conflict
 * possible). On a conflicted merge (exit 1) returns `{ treeOid, files }`,
 * where `files` is the RAW, unquoted list of conflicted paths. Any other
 * outcome (a real git error — bad revision, corrupt repo, etc.) is rethrown;
 * callers that want a "just skip this one and count it" policy (see
 * `replay-regenerate.mjs`) should wrap the call themselves.
 *
 * Bug (found by independent review after the regenerate-tier sweep already
 * shipped): the default (non-`-z`) `--name-only` output C-quotes any path
 * containing a `"` character or a non-ASCII byte (see `git help
 * merge-tree`'s "Conflicted file info" section — quoting follows
 * `core.quotePath`'s rule, unconditionally for embedded `"`). Those quoted,
 * escaped strings never match the RAW bytes `seedScratchIndex`
 * (scripts/lib/seed-index.mjs) compares `skipPaths` against (it reads via
 * `git ls-tree -z`, always unquoted) — so a C-quoted conflicted path would
 * silently fail to be recognised as a skip path, leaking literal diff3
 * marker content into the scratch index — exactly the failure mode
 * `skipPaths` exists to prevent, just one layer upstream. Fixed by using
 * `-z` for the `merge-tree` invocation itself.
 *
 * `-z` output shape for a non-`--stdin` invocation — confirmed empirically
 * against a real git 2.50 binary (see merge-tree.test.mjs); do NOT trust
 * `git help merge-tree`'s prose alone for the exact delimiter shape, since it
 * describes the general grammar but not this file's exact byte-for-byte
 * token boundaries:
 *
 *   <treeOid>\0<path1>\0<path2>\0...\0<pathN>\0\0<message records...>\0
 *
 * i.e. the tree OID, then each conflicted path as its own NUL-terminated
 * raw-byte token (no quoting), then ONE EXTRA NUL marking the start of the
 * messages section (per `git help merge-tree`: "-z ... Also begin the
 * messages section with a NUL character instead of a newline" — mirroring
 * the blank-line separator in the non-`-z` format), then zero or more
 * message records this function does not need and ignores. On a clean merge
 * (exit 0) the output is just `<treeOid>\0` — no path list, no messages,
 * since `--[no-]messages` defaults to omitting them when there is nothing to
 * report.
 */
import { execFileSync } from "node:child_process";

export function mergeTree(repo, p1, p2) {
  try {
    execFileSync(
      "git",
      ["-C", repo, "-c", "merge.conflictstyle=diff3", "merge-tree", "-z", "--write-tree", "--name-only", p1, p2],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return null; // exit 0 → clean merge, no lockfile conflict possible
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === "string") {
      const tokens = err.stdout.split("\0");
      const treeOid = tokens[0];
      // Paths run from index 1 up to (not including) the first empty-string
      // token: that token is either the extra NUL marking the start of the
      // messages section, or (if there happen to be zero conflicted paths)
      // immediately follows the OID. Both cases are handled the same way.
      let end = tokens.indexOf("", 1);
      if (end === -1) end = tokens.length; // defensive: real -z output always has one
      const files = tokens.slice(1, end);
      return { treeOid, files };
    }
    throw err;
  }
}
