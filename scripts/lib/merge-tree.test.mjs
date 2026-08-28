import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTree } from "./merge-tree.mjs";
import { seedScratchIndex } from "./seed-index.mjs";

// Hermetic git env — same reason as seed-index.test.mjs: without this, the
// host machine's global/system git config can make a plumbing call hang or
// behave unpredictably.
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

/** `git ls-files -s -z` against a scratch index, decoded to raw path names. */
function lsFilesScratchNames(repo, indexPath) {
  const out = git(repo, ["ls-files", "-s", "-z"], { env: { GIT_INDEX_FILE: indexPath } });
  return out
    .split("\0")
    .filter((e) => e.length > 0)
    .map((e) => e.slice(e.indexOf("\t") + 1));
}

test("mergeTree returns null for a clean merge", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-mergetree-clean-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "a.txt"), "theirs a\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "b.txt"), "main b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    assert.equal(mergeTree(repo, mainSha, theirsSha), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("mergeTree returns the tree oid and raw conflicted paths for a multi-file conflict", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-mergetree-multi-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "a.txt"), "theirs a\n");
    writeFileSync(join(repo, "b.txt"), "theirs b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "a.txt"), "main a\n");
    writeFileSync(join(repo, "b.txt"), "main b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    const result = mergeTree(repo, mainSha, theirsSha);
    assert.ok(result, "expected a conflict result");
    assert.match(result.treeOid, /^[0-9a-f]{40}$/, "treeOid must be a real sha");
    assert.deepEqual([...result.files].sort(), ["a.txt", "b.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Bug A — the actual regression. The default (non-`-z`) `--name-only` output
// C-quotes a path containing a literal `"` and a non-ASCII byte; the fixed
// `-z` invocation must return it RAW and unquoted so it matches the bytes
// `git ls-tree -z` (and thus `seedScratchIndex`'s skip-matching) produces.
test("mergeTree returns a path containing a quote and a non-ASCII byte RAW, not C-quoted", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-mergetree-quoting-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, "sub"), { recursive: true });
    const trickyName = 'café "quote".lock';
    writeFileSync(join(repo, "sub", trickyName), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "sub", trickyName), "theirs change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "sub", trickyName), "main change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    const result = mergeTree(repo, mainSha, theirsSha);
    assert.ok(result, "expected a conflict result");
    const expected = `sub/${trickyName}`;
    assert.deepEqual(
      result.files,
      [expected],
      `expected the RAW unquoted path, got: ${JSON.stringify(result.files)}`,
    );
    // Sanity: prove this path really would have been C-quoted by git's
    // default (non-`-z`) output, so this test would have caught the
    // original bug (a regression back to the non-`-z` invocation). Only the
    // "Conflicted file info" section (the paragraph right after the tree
    // oid) is quoted — the free-form "Informational messages" section that
    // follows the blank-line separator is NOT quoted, so the check must be
    // scoped to that first paragraph, not the whole output.
    let nonZOutput;
    try {
      git(repo, ["-c", "merge.conflictstyle=diff3", "merge-tree", "--write-tree", "--name-only", mainSha, theirsSha]);
      assert.fail("expected merge-tree to exit 1 on conflict");
    } catch (err) {
      nonZOutput = err.stdout;
    }
    const [, conflictedFileInfo] = nonZOutput.split("\n\n")[0].split("\n");
    assert.notEqual(
      conflictedFileInfo,
      expected,
      "sanity check: the default output's Conflicted file info section must be C-quoted, not the raw path — otherwise this test cannot prove the -z fix matters",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("mergeTree rethrows on a genuine git error (not a recognised conflict outcome)", () => {
  // A nonexistent repo path makes `git -C <path> ...` fail with exit 128
  // ("fatal: cannot change to ...") before merge-tree itself ever runs —
  // confirmed empirically to NOT collide with the exit-1 conflict path,
  // unlike unresolvable revision names against a real repo (git's
  // merge-tree also exits 1 for "not something we can merge", with empty
  // stdout — a separate, pre-existing ambiguity this function does not try
  // to disambiguate; this test targets the unambiguous case instead).
  assert.throws(() => mergeTree(join(tmpdir(), "gw-mergetree-does-not-exist"), "HEAD", "HEAD"));
});

// End-to-end pipeline proof (the actual bug, not just mergeTree()'s return
// value in isolation): a C-quoted skip path must now be correctly matched
// and removed by seedScratchIndex, so no diff3 marker content leaks into the
// scratch index. This is the exact `mergeTree()` -> `conflictedPaths` ->
// `skipPaths` -> `seedScratchIndex` pipeline replay-regenerate.mjs runs.
test("end-to-end: a quoted/unicode conflicted path from mergeTree() is correctly skipped by seedScratchIndex", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-mergetree-e2e-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, "sub"), { recursive: true });
    const trickyName = 'café "quote".lock';
    writeFileSync(join(repo, "sub", trickyName), "base\n");
    writeFileSync(join(repo, "clean-only.txt"), "will only exist on theirs\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "sub", trickyName), "theirs change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "sub", trickyName), "main change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    // Stage 1 (candidate discovery), for real, via the fixed mergeTree().
    const conflict = mergeTree(repo, mainSha, theirsSha);
    assert.ok(conflict, "expected a conflict result");
    const trickyPath = `sub/${trickyName}`;
    assert.ok(
      conflict.files.includes(trickyPath),
      `mergeTree() must report the raw tricky path as conflicted, got: ${JSON.stringify(conflict.files)}`,
    );

    // Stage 1's candidate.conflictedPaths becomes seedScratchIndex's
    // skipPaths, exactly as replay-regenerate.mjs wires it.
    const scratchIndex = join(repo, ".git", "scratch-e2e-index");
    seedScratchIndex(repo, conflict.treeOid, scratchIndex, conflict.files);

    const names = lsFilesScratchNames(repo, scratchIndex);
    assert.ok(
      !names.includes(trickyPath),
      `the quoted/unicode conflicted path must be ABSENT from the scratch index (correctly skipped, no marker-content leak) — got: ${JSON.stringify(names)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
