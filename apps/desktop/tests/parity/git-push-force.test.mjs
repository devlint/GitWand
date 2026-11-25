/**
 * Parity tests: `git_push` force paths (Rust) vs `/api/git-push`
 * (dev-server), and `git_stash_show` vs `/api/git-stash-show`.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * A push mutates the remote, so each side gets its own freshly built
 * remote + clones. Parity is asserted on success and on where the remote
 * branch ends up (by commit subject: SHAs differ between the two builds).
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@gitwand.test",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@gitwand.test",
  GIT_EDITOR: "true",
};

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();

const dirs = [];

function commit(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

/** A remote with `feature`, the user's clone `me` on it and a teammate's. */
function published() {
  const root = mkdtempSync(join(tmpdir(), "gitwand-parity-push-"));
  dirs.push(root);
  const remote = join(root, "remote.git");
  const mate = join(root, "mate");
  const me = join(root, "me");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
  execFileSync("git", ["clone", "-q", remote, me], { env: ENV });
  commit(me, "f", "base\n", "base");
  git(me, ["push", "-q", "origin", "main"]);
  git(me, ["switch", "-q", "-c", "feature"]);
  commit(me, "f", "one\n", "feature 1");
  git(me, ["push", "-q", "-u", "origin", "feature"]);
  execFileSync("git", ["clone", "-q", "-b", "feature", remote, mate], { env: ENV });
  return { remote, me, mate };
}

const subject = (remote, ref) => git(remote, ["log", "-1", "--format=%s", ref]);

async function nodePush(dev, body) {
  const res = await dev.fetch("/api/git-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function rustRun(command, args) {
  const r = runProbe("command-parity", { command, args });
  if (/command-parity does not know/.test(String(r.error))) {
    throw new Error(`the probe has no arm for '${command}'. Rebuild it: cargo build --example parity-probe`);
  }
  expect(r.ok, `rust failed: ${r.error}`).toBe(true);
  return r.value;
}

let dev;
beforeAll(async () => {
  dev = await startDevServer();
}, 15_000);
afterAll(async () => {
  await dev?.stop();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("git_push force parity", () => {
  // The background fetch brought a teammate's commit into origin/feature;
  // the user amended without pulling it. Both refuse, the remote keeps it.
  it("refuses to overwrite a fetched commit never integrated", async () => {
    const sides = [published(), published()];
    for (const { me, mate } of sides) {
      commit(mate, "m", "mate\n", "mate");
      git(mate, ["push", "-q", "origin", "feature"]);
      git(me, ["fetch", "-q"]);
      git(me, ["commit", "-q", "--amend", "-m", "feature 1 amended"]);
    }
    const rust = rustRun("git_push", { cwd: sides[0].me, force: true });
    const node = await nodePush(dev, { cwd: sides[1].me, force: true });
    expect(rust.success).toBe(false);
    expect(node.success).toBe(false);
    for (const { remote } of sides) expect(subject(remote, "feature")).toBe("mate");
  });

  it("force-pushes a rewrite of the user's own commits", async () => {
    const sides = [published(), published()];
    for (const { me } of sides) git(me, ["commit", "-q", "--amend", "-m", "feature 1 amended"]);
    const rust = rustRun("git_push", { cwd: sides[0].me, force: true });
    const node = await nodePush(dev, { cwd: sides[1].me, force: true });
    expect(rust.success, rust.message).toBe(true);
    expect(node.success, node.message).toBe(true);
    for (const { remote } of sides) expect(subject(remote, "feature")).toBe("feature 1 amended");
  });

  // push.default=upstream, local `feature` tracking `origin/topic`: the
  // explicit lease names `topic`, the branch the push updates.
  it("leases the push destination, not the local branch name", async () => {
    const sides = [published(), published()];
    const leases = sides.map(({ me }) => {
      git(me, ["push", "-q", "origin", "feature:topic"]);
      git(me, ["fetch", "-q"]);
      git(me, ["branch", "-q", "--set-upstream-to=origin/topic"]);
      git(me, ["config", "push.default", "upstream"]);
      const judged = git(me, ["rev-parse", "origin/topic"]);
      git(me, ["commit", "-q", "--amend", "-m", "amended"]);
      return judged;
    });
    const rust = rustRun("git_push", {
      cwd: sides[0].me,
      force: true,
      leaseBranch: "feature",
      leaseSha: leases[0],
    });
    const node = await nodePush(dev, {
      cwd: sides[1].me,
      force: true,
      leaseBranch: "feature",
      leaseSha: leases[1],
    });
    expect(rust.success, rust.message).toBe(true);
    expect(node.success, node.message).toBe(true);
    for (const { remote } of sides) expect(subject(remote, "topic")).toBe("amended");
  });
});

describe("git_stash_show parity", () => {
  it("ignores the user's patch config, like git_show", async () => {
    const { me } = published();
    writeFileSync(join(me, "é t.txt"), "v1\n");
    git(me, ["add", "-A"]);
    git(me, ["commit", "-q", "-m", "named"]);
    writeFileSync(join(me, "é t.txt"), "v2\n");
    git(me, ["stash", "push", "-q"]);
    for (const [k, v] of [
      ["diff.noprefix", "true"],
      ["diff.srcPrefix", "SRC/"],
      ["diff.dstPrefix", "DST/"],
      ["color.ui", "always"],
      ["core.quotePath", "true"],
      ["diff.external", "echo EXTERNAL"],
    ]) {
      git(me, ["config", k, v]);
    }
    const rust = rustRun("git_stash_show", { cwd: me, index: 0 });
    const res = await dev.fetch(`/api/git-stash-show?cwd=${encodeURIComponent(me)}&index=0`);
    const node = await res.json();
    expect(node.diff).toBe(rust.diff);
    expect(rust.diff).toContain("diff --git a/é t.txt b/é t.txt");
  });
});
