/**
 * Wire-contract test for `POST /api/git-cherry-pick`'s `noCommit` field
 * ("Cherry-pick onto current branch as WIP").
 *
 * No Rust probe needed here — `git_cherry_pick`'s `no_commit: Option<bool>`
 * and this dev-server route are two independent implementations of the same
 * git invocation, and this guards the `pnpm dev:web` path specifically, same
 * shape as git-pull-autostash.test.mjs.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { mkTempRepo, commitFile } from "./fixtures.mjs";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/** `main` with one commit, plus a `feature` commit adding feature.txt. */
function repoWithFeatureCommit(label) {
  const cwd = mkTempRepo(label);
  commitFile(cwd, "base.txt", "base\n", "initial commit", 0);
  git(cwd, ["checkout", "--quiet", "-b", "feature"]);
  commitFile(cwd, "feature.txt", "feature\n", "feat: add feature.txt", 1);
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["checkout", "--quiet", "main"]);
  return { cwd, sha };
}

async function cherryPick(dev, body) {
  const res = await dev.fetch("/api/git-cherry-pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe("dev-server wire contract: /api/git-cherry-pick noCommit", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("noCommit: true stages the changes without committing or leaving an operation in progress", async () => {
    const { cwd, sha } = repoWithFeatureCommit("gw-cp-wip-");
    const headBefore = git(cwd, ["rev-parse", "HEAD"]);

    const body = await cherryPick(dev, { cwd, hashes: [sha], noCommit: true });

    expect(body.success).toBe(true);
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(cwd, ["status", "--porcelain"])).toBe("A  feature.txt");
    expect(readFileSync(join(cwd, "feature.txt"), "utf-8")).toBe("feature\n");
    expect(existsSync(join(cwd, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
  });

  it("noCommit absent still commits the pick", async () => {
    const { cwd, sha } = repoWithFeatureCommit("gw-cp-commit-");

    const body = await cherryPick(dev, { cwd, hashes: [sha] });

    expect(body.success).toBe(true);
    expect(git(cwd, ["log", "-1", "--format=%s"])).toBe("feat: add feature.txt");
    expect(git(cwd, ["status", "--porcelain"])).toBe("");
  });
});
