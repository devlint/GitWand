import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedScratchIndex } from "./seed-index.mjs";

// Hermetic git env — same reason as merge-context-detect.test.ts /
// regenerate-runner.test.ts: without this, the host machine's global/system
// git config (hooksPath, GPG signing, editor…) can make a plumbing call hang
// or behave unpredictably.
const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    ...opts,
    env: { ...HERMETIC_GIT_ENV, ...(opts.env ?? {}) },
  });
}

/** `git ls-files -s` against a scratch index via `GIT_INDEX_FILE`. */
function lsFilesScratch(repo, indexPath) {
  return git(repo, ["ls-files", "-s"], {
    env: { GIT_INDEX_FILE: indexPath },
  });
}

/**
 * `git merge-tree --write-tree` exits 1 (not 0) whenever the merge produces
 * a conflict — the tree oid is still the first line of stdout even then.
 * Mirrors `replay-regenerate.mjs`'s own `mergeTree()` handling.
 */
function mergeTreeWriteTree(repo, p1, p2) {
  try {
    const out = git(repo, ["-c", "merge.conflictstyle=diff3", "merge-tree", "--write-tree", p1, p2]);
    return out.trim().split("\n")[0];
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === "string") {
      return err.stdout.trim().split("\n")[0];
    }
    throw err;
  }
}

test("seedScratchIndex materializes a theirs-only file into a scratch index without touching the repo's real index", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-seed-index-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "package.json"), '{"v":1}\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "theirs-only.txt"), "only on theirs\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs adds a file"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "package.json"), '{"v":2}\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main bumps a value"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    const merged = git(repo, [
      "-c", "merge.conflictstyle=diff3",
      "merge-tree", "--write-tree", mainSha, theirsSha,
    ]).trim();
    const treeOid = merged.split("\n")[0];

    const realIndexBefore = readFileSync(join(repo, ".git", "index"));

    const scratchIndex = join(repo, ".git", "scratch-test-index");
    seedScratchIndex(repo, treeOid, scratchIndex);

    assert.ok(existsSync(scratchIndex), "scratch index file must be created");
    // The repo's own index must be byte-for-byte untouched.
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), realIndexBefore);

    // Behavioral assertion must read back the SCRATCH INDEX itself (via
    // `ls-files -s` with `GIT_INDEX_FILE` pointed at it) — not a property of
    // the source tree (`git ls-tree <treeOid>`), which is true regardless of
    // whether `seedScratchIndex` did anything at all.
    const listing = lsFilesScratch(repo, scratchIndex);
    assert.ok(listing.includes("theirs-only.txt"), "theirs-only.txt must be present in the scratch index");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("seedScratchIndex(skipPaths) removes still-conflicted paths from the scratch index, matching production's multi-stage skip", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-seed-index-skip-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "conflicted.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "conflicted.txt"), "theirs change\n");
    writeFileSync(join(repo, "clean-only.txt"), "only on theirs, no conflict\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs: conflicting change + a clean add"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "conflicted.txt"), "main change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main: conflicting change"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    // `merge-tree --write-tree` produces a genuine conflict on
    // conflicted.txt (diff3 marker content as the blob's literal text) and a
    // clean merge for clean-only.txt (theirs-only, no conflict). It exits 1
    // (not 0) because of the conflict — see mergeTreeWriteTree()'s doc.
    const treeOid = mergeTreeWriteTree(repo, mainSha, theirsSha);

    const scratchIndex = join(repo, ".git", "scratch-test-index-skip");
    seedScratchIndex(repo, treeOid, scratchIndex, ["conflicted.txt"]);

    const listing = lsFilesScratch(repo, scratchIndex);
    assert.ok(
      !listing.includes("conflicted.txt"),
      `conflicted.txt must be ABSENT from the scratch index (skipped, like production's multi-stage skip) — got:\n${listing}`,
    );
    assert.ok(
      listing.includes("clean-only.txt"),
      `clean-only.txt must be present at stage 0 in the scratch index — got:\n${listing}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
