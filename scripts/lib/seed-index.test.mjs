import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedScratchIndex } from "./seed-index.mjs";

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", ...opts });
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

    const listing = git(repo, ["ls-tree", "-r", "--name-only", treeOid]);
    assert.ok(listing.includes("theirs-only.txt"), "merged tree must include the theirs-only file");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
