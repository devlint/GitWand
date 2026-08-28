import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

// Regenerate-sweep re-run #2 — the bug this test exists to catch (and the
// prior two tests above never could): `git update-index --force-remove`
// fails with `fatal: this operation must be run in a work tree` against a
// BARE repo, even though it only edits an index file and never touches the
// filesystem. The real corpus (`benchmark/run.mjs`'s `prepare()`) clones
// bare + blobless, so this is the shape that actually matters in production
// use of this harness. Build commits in an ordinary non-bare repo (bare repos
// have no work tree to `git add`/`git commit` against), then `git clone
// --bare` it into a second temp path and exercise `seedScratchIndex` against
// THAT bare clone.
//
// The fixture ALSO puts one skipped and one kept file inside a nested
// subdirectory (`src/nested/...`) — a real, real-world repo (prettier) turned
// up a second bug the first version of this test's flat-only fixture missed
// entirely: `git mktree` (unlike `ls-tree -r`) does not reconstruct nested
// subtrees on its own and rejects any path containing a slash with `fatal:
// path ... contains slash`. A fixture with only root-level files can never
// exercise that failure mode.
test("seedScratchIndex(skipPaths) works against a BARE repo with nested paths (no work tree) — the real corpus's shape", () => {
  const srcRepo = mkdtempSync(join(tmpdir(), "gw-seed-index-bare-src-"));
  const bareRepo = mkdtempSync(join(tmpdir(), "gw-seed-index-bare-"));
  try {
    git(srcRepo, ["init", "-q", "-b", "main"]);
    git(srcRepo, ["config", "user.email", "t@t.com"]);
    git(srcRepo, ["config", "user.name", "t"]);
    mkdirSync(join(srcRepo, "src", "nested"), { recursive: true });
    writeFileSync(join(srcRepo, "conflicted.txt"), "base\n");
    writeFileSync(join(srcRepo, "src", "nested", "conflicted-nested.txt"), "base nested\n");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["commit", "-q", "-m", "base"]);

    git(srcRepo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(srcRepo, "conflicted.txt"), "theirs change\n");
    writeFileSync(join(srcRepo, "src", "nested", "conflicted-nested.txt"), "theirs nested change\n");
    writeFileSync(join(srcRepo, "clean-only.txt"), "only on theirs, no conflict\n");
    writeFileSync(join(srcRepo, "src", "nested", "clean-nested.txt"), "only on theirs, nested, no conflict\n");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["commit", "-q", "-m", "theirs: conflicting changes (root + nested) + clean adds (root + nested)"]);
    const theirsSha = git(srcRepo, ["rev-parse", "HEAD"]).trim();

    git(srcRepo, ["checkout", "-q", "main"]);
    writeFileSync(join(srcRepo, "conflicted.txt"), "main change\n");
    writeFileSync(join(srcRepo, "src", "nested", "conflicted-nested.txt"), "main nested change\n");
    git(srcRepo, ["add", "-A"]);
    git(srcRepo, ["commit", "-q", "-m", "main: conflicting changes (root + nested)"]);
    const mainSha = git(srcRepo, ["rev-parse", "HEAD"]).trim();

    const treeOid = mergeTreeWriteTree(srcRepo, mainSha, theirsSha);

    // Re-create bareRepo as an actual bare clone of srcRepo (mkdtempSync
    // already created bareRepo as an empty dir — `clone --bare` needs to
    // create/populate its target, so remove it first and let clone recreate it).
    rmSync(bareRepo, { recursive: true, force: true });
    git(srcRepo, ["clone", "-q", "--bare", srcRepo, bareRepo]);
    assert.equal(
      git(bareRepo, ["rev-parse", "--is-bare-repository"]).trim(),
      "true",
      "fixture must actually be bare, or this test proves nothing",
    );

    const scratchIndex = join(bareRepo, "scratch-test-index-bare-skip");
    // Must NOT throw `fatal: this operation must be run in a work tree` NOR
    // `fatal: path ... contains slash`.
    seedScratchIndex(bareRepo, treeOid, scratchIndex, ["conflicted.txt", "src/nested/conflicted-nested.txt"]);

    const listing = lsFilesScratch(bareRepo, scratchIndex);
    assert.ok(
      !listing.includes("conflicted.txt") || listing.includes("src/nested/conflicted-nested.txt") === false,
      `sanity: listing must not be empty/garbage — got:\n${listing}`,
    );
    assert.ok(
      !listing.split("\n").some((l) => l.endsWith("\tconflicted.txt")),
      `root-level conflicted.txt must be ABSENT from the scratch index built against a bare repo — got:\n${listing}`,
    );
    assert.ok(
      !listing.includes("src/nested/conflicted-nested.txt"),
      `nested conflicted-nested.txt must be ABSENT from the scratch index built against a bare repo — got:\n${listing}`,
    );
    assert.ok(
      listing.includes("clean-only.txt"),
      `root-level clean-only.txt must be present at stage 0 — got:\n${listing}`,
    );
    assert.ok(
      listing.includes("src/nested/clean-nested.txt"),
      `nested clean-nested.txt must be present at stage 0, with its full nested path intact — got:\n${listing}`,
    );
  } finally {
    rmSync(srcRepo, { recursive: true, force: true });
    rmSync(bareRepo, { recursive: true, force: true });
  }
});

// Regenerate-sweep re-run #2, second finding — a real corpus repo
// (prettier/prettier) turned up a case no hand-built fixture had covered:
// git C-quotes filenames with special characters (spaces, double quotes,
// unicode) in the default (non-`-z`) output of both `ls-tree` and `mktree`.
// Reassembling a hand-parsed quoted name (e.g. splitting on "/" or matching
// it against a skip path) breaks and surfaces as `fatal: invalid quoting`.
// This fixture puts a filename containing a double quote and a space
// ALONGSIDE the skipped file at the very same tree level, so a regression
// back to non-`-z` parsing would corrupt or drop it.
test("seedScratchIndex(skipPaths) tolerates sibling filenames with quotes/spaces that git C-quotes by default", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-seed-index-quoting-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    const trickyName = 'weird "quoted" file with spaces.txt';
    writeFileSync(join(repo, "conflicted.txt"), "base\n");
    writeFileSync(join(repo, trickyName), "base tricky\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "conflicted.txt"), "theirs change\n");
    writeFileSync(join(repo, trickyName), "theirs tricky change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs: conflicting change + a clean edit of a tricky filename"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "conflicted.txt"), "main change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main: conflicting change"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    const treeOid = mergeTreeWriteTree(repo, mainSha, theirsSha);

    const scratchIndex = join(repo, ".git", "scratch-test-index-quoting");
    // Must NOT throw `fatal: invalid quoting`.
    seedScratchIndex(repo, treeOid, scratchIndex, ["conflicted.txt"]);

    // `-z` (NUL-terminated) so `trickyName`'s embedded literal quote comes
    // back as a raw byte instead of git's own C-quoted/escaped
    // representation (which any name containing a literal `"` always gets,
    // regardless of `core.quotepath` — that setting only affects non-ASCII,
    // not embedded quote characters) — otherwise this assertion would need
    // to hand-construct the escaped form itself.
    const listingZ = git(repo, ["ls-files", "-s", "-z"], {
      env: { GIT_INDEX_FILE: scratchIndex },
    });
    const names = listingZ
      .split("\0")
      .filter((e) => e.length > 0)
      .map((e) => e.slice(e.indexOf("\t") + 1));
    assert.ok(
      !names.includes("conflicted.txt"),
      `conflicted.txt must be ABSENT from the scratch index — got:\n${JSON.stringify(names)}`,
    );
    assert.ok(
      names.includes(trickyName),
      `sibling file with quotes/spaces must survive intact (not corrupted, not dropped) — got:\n${JSON.stringify(names)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
