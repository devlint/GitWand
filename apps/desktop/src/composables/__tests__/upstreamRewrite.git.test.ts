/**
 * Real-git tests for `isUpstreamRewriteOnly()` (#223).
 *
 * When a remote branch is rebased and force-pushed, a local copy with no
 * commits of its own shows as diverged (its old commits count as "ahead").
 * Merging the rewritten history into the old one then conflicts for no
 * reason. The detector must say "rewrite only" exactly when every local
 * commit was once upstream's — git's fork-point equals the local tip — and
 * never when the user has work of their own on the branch.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "GitWand Test",
    GIT_AUTHOR_EMAIL: "test@gitwand.test",
    GIT_COMMITTER_NAME: "GitWand Test",
    GIT_COMMITTER_EMAIL: "test@gitwand.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EDITOR: "true",
    EDITOR: "true",
    LC_ALL: "C",
  };
}

// Route the module's gitExec to real git.
vi.mock("../../utils/backend", () => ({
  gitExec: vi.fn(async (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  }),
}));

import {
  isUpstreamRewriteOnly,
  isLocalRewriteOfUpstream,
  probeLocalRewriteOfUpstream,
  evaluateAutoForcePush,
} from "../useBranchUpdatePrompt";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(cwd: string, file: string, content: string, message: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
}

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/**
 * A remote, a "teammate" clone that owns `feat`, and the user's clone `me`
 * that checked `feat` out earlier. Returns both clone paths.
 */
function setup(): { teammate: string; me: string } {
  root = mkdtempSync(join(tmpdir(), "gitwand-rewrite-"));
  const remote = join(root, "remote.git");
  const teammate = join(root, "teammate");
  const me = join(root, "me");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  git(root, ["clone", "-q", remote, teammate]);
  commit(teammate, "f", "a\nb\nc\n", "base");
  git(teammate, ["push", "-q", "origin", "main"]);
  git(teammate, ["switch", "-q", "-c", "feat"]);
  commit(teammate, "f", "a\nFEAT\nc\n", "f1");
  commit(teammate, "g", "x\n", "f2");
  git(teammate, ["push", "-q", "-u", "origin", "feat"]);
  git(root, ["clone", "-q", remote, me]);
  git(me, ["switch", "-q", "feat"]);
  return { teammate, me };
}

/** Teammate moves main, rebases feat onto it (resolving f), force-pushes. */
function rewriteAndForcePush(teammate: string) {
  git(teammate, ["switch", "-q", "main"]);
  commit(teammate, "f", "a\nMAIN\nc\n", "m2");
  git(teammate, ["push", "-q", "origin", "main"]);
  git(teammate, ["switch", "-q", "feat"]);
  spawnSync("git", ["rebase", "main"], { cwd: teammate, env: gitEnv() });
  writeFileSync(join(teammate, "f"), "a\nMAIN+FEAT\nc\n");
  git(teammate, ["add", "f"]);
  git(teammate, ["rebase", "--continue"]);
  git(teammate, ["push", "-q", "-f", "origin", "feat"]);
}

describe("isUpstreamRewriteOnly", () => {
  it("is true when the upstream was rewritten and the branch has no own commits", async () => {
    const { teammate, me } = setup();
    rewriteAndForcePush(teammate);
    git(me, ["fetch", "-q"]);
    expect(await isUpstreamRewriteOnly(me)).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("is false when the user committed on top of the old upstream", async () => {
    const { teammate, me } = setup();
    commit(me, "h", "mine\n", "my own work");
    rewriteAndForcePush(teammate);
    git(me, ["fetch", "-q"]);
    expect(await isUpstreamRewriteOnly(me)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("is false for a genuine divergence without any rewrite", async () => {
    const { teammate, me } = setup();
    commit(me, "h", "mine\n", "my own work");
    commit(teammate, "i", "theirs\n", "their work");
    git(teammate, ["push", "-q", "origin", "feat"]);
    git(me, ["fetch", "-q"]);
    expect(await isUpstreamRewriteOnly(me)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("is false without an upstream", async () => {
    const { me } = setup();
    git(me, ["switch", "-q", "-c", "local-only"]);
    expect(await isUpstreamRewriteOnly(me)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});

/** main moves (on a file feat doesn't touch); `me` rebases feat onto it locally. */
function rebaseLocallyOntoMovedMain(teammate: string, me: string) {
  git(teammate, ["switch", "-q", "main"]);
  commit(teammate, "m", "main\n", "m2");
  git(teammate, ["push", "-q", "origin", "main"]);
  git(me, ["fetch", "-q"]);
  git(me, ["rebase", "-q", "origin/main"]);
}

describe("isLocalRewriteOfUpstream", () => {
  it("is true after a local rebase that kept every upstream commit", async () => {
    const { teammate, me } = setup();
    rebaseLocallyOntoMovedMain(teammate, me);
    expect(await isLocalRewriteOfUpstream(me, "feat")).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("is true after a local rebase whose conflicts changed the patches", async () => {
    const { teammate, me } = setup();
    git(teammate, ["switch", "-q", "main"]);
    commit(teammate, "f", "a\nMAIN\nc\n", "m2");
    git(teammate, ["push", "-q", "origin", "main"]);
    git(me, ["fetch", "-q"]);
    spawnSync("git", ["rebase", "origin/main"], { cwd: me, env: gitEnv() });
    writeFileSync(join(me, "f"), "a\nMAIN+FEAT\nc\n");
    git(me, ["add", "f"]);
    git(me, ["rebase", "--continue"]);
    expect(await isLocalRewriteOfUpstream(me, "feat")).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("is false when the upstream gained a commit the rebase doesn't have", async () => {
    const { teammate, me } = setup();
    git(teammate, ["switch", "-q", "feat"]);
    commit(teammate, "i", "theirs\n", "their work");
    git(teammate, ["push", "-q", "origin", "feat"]);
    rebaseLocallyOntoMovedMain(teammate, me);
    expect(await isLocalRewriteOfUpstream(me, "feat")).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("is false for a genuine divergence without any rewrite", async () => {
    const { teammate, me } = setup();
    commit(me, "h", "mine\n", "my own work");
    commit(teammate, "i", "theirs\n", "their work");
    git(teammate, ["push", "-q", "origin", "feat"]);
    git(me, ["fetch", "-q"]);
    expect(await isLocalRewriteOfUpstream(me, "feat")).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("is false without an upstream", async () => {
    const { me } = setup();
    git(me, ["switch", "-q", "-c", "local-only"]);
    expect(await isLocalRewriteOfUpstream(me, "local-only")).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("isLocalRewriteOfUpstream — remote merge commits", () => {
  it("is false when the upstream holds a merge commit with content of its own", async () => {
    const { teammate, me } = setup();
    // Teammate merges a moved main into feat, adding a file inside the merge.
    git(teammate, ["switch", "-q", "main"]);
    commit(teammate, "m", "main\n", "m2");
    git(teammate, ["push", "-q", "origin", "main"]);
    git(teammate, ["switch", "-q", "feat"]);
    git(teammate, ["merge", "-q", "--no-ff", "--no-commit", "main"]);
    writeFileSync(join(teammate, "extra"), "only in the merge\n");
    git(teammate, ["add", "extra"]);
    git(teammate, ["commit", "-q", "-m", "merge main into feat"]);
    git(teammate, ["push", "-q", "origin", "feat"]);
    // Meanwhile `me` rebases its (older) feat onto main without that merge.
    git(me, ["fetch", "-q"]);
    git(me, ["rebase", "-q", "origin/main", "feat"]);
    expect(git(me, ["rev-list", "--count", "HEAD...@{upstream}"]).trim()).not.toBe("0");
    expect(await isLocalRewriteOfUpstream(me, "feat")).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("probeLocalRewriteOfUpstream", () => {
  it("reports the upstream sha it judged", async () => {
    const { teammate, me } = setup();
    rebaseLocallyOntoMovedMain(teammate, me);
    const probe = await probeLocalRewriteOfUpstream(me, "feat");
    expect(probe.safe).toBe(true);
    expect(probe.upstream).toBe(git(me, ["rev-parse", "origin/feat"]).trim());
  }, GIT_TEST_TIMEOUT_MS);

  it("has no upstream without tracking", async () => {
    const { me } = setup();
    git(me, ["switch", "-q", "-c", "local-only"]);
    expect(await probeLocalRewriteOfUpstream(me, "local-only")).toEqual({ safe: false, upstream: null });
  }, GIT_TEST_TIMEOUT_MS);
});

describe("evaluateAutoForcePush", () => {
  it("sets the preference with the judged upstream sha after a local rewrite", async () => {
    const { teammate, me } = setup();
    rebaseLocallyOntoMovedMain(teammate, me);
    const v = await evaluateAutoForcePush(me, "feat", { preferred: false, autoSha: null });
    expect(v).toEqual({ action: "set", upstream: git(me, ["rev-parse", "origin/feat"]).trim() });
  }, GIT_TEST_TIMEOUT_MS);

  it("clears an auto preference once a collaborator's push lands in origin/feat", async () => {
    const { teammate, me } = setup();
    // Collaborator pushes on top of what I pushed; I rebase before fetching it.
    git(teammate, ["switch", "-q", "feat"]);
    commit(teammate, "i", "theirs\n", "their work");
    git(teammate, ["push", "-q", "origin", "feat"]);
    git(teammate, ["switch", "-q", "main"]);
    commit(teammate, "m", "main\n", "m2");
    git(teammate, ["push", "-q", "origin", "main"]);
    git(me, ["fetch", "-q", "origin", "main"]);
    git(me, ["rebase", "-q", "origin/main"]);
    const first = await evaluateAutoForcePush(me, "feat", { preferred: false, autoSha: null });
    expect(first.action).toBe("set");
    const autoSha = (first as { upstream: string }).upstream;
    // Auto-fetch brings their commit in: the same preference must now be dropped.
    git(me, ["fetch", "-q"]);
    expect(await evaluateAutoForcePush(me, "feat", { preferred: true, autoSha })).toEqual({ action: "clear" });
  }, GIT_TEST_TIMEOUT_MS);

  it("leaves an explicit preference (no recorded sha) alone, even if the probe says no", async () => {
    const { teammate, me } = setup();
    commit(me, "h", "mine\n", "my own work");
    commit(teammate, "i", "theirs\n", "their work");
    git(teammate, ["push", "-q", "origin", "feat"]);
    git(me, ["fetch", "-q"]);
    expect(await evaluateAutoForcePush(me, "feat", { preferred: true, autoSha: null })).toEqual({ action: "keep" });
  }, GIT_TEST_TIMEOUT_MS);

  it("keeps an auto preference whose upstream is unchanged and still safe", async () => {
    const { teammate, me } = setup();
    rebaseLocallyOntoMovedMain(teammate, me);
    const autoSha = git(me, ["rev-parse", "origin/feat"]).trim();
    expect(await evaluateAutoForcePush(me, "feat", { preferred: true, autoSha })).toEqual({ action: "keep" });
  }, GIT_TEST_TIMEOUT_MS);
});
