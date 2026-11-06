/**
 * Parity tests — `worktree_merge_back_check` (Rust) vs
 * `/api/worktree-merge-back-check` (Node dev-server). Spec §12: what the
 * merge-back dialog is told about a task must be the same in `dev:web` and
 * in the app.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureClean } from "./fixtures.mjs";

/** A recorded task worktree with one commit, like the worktree service makes. */
function task(cwd, name) {
  const path = `${cwd}.worktrees/${name}`;
  const branch = `task/${name}`;
  execFileSync("git", ["-C", cwd, "worktree", "add", "-q", "-b", branch, path]);
  const real = realpathSync(path);
  const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8" }).trim();
  mkdirSync(join(common, "gitwand"), { recursive: true });
  const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  writeFileSync(
    join(common, "gitwand", "worktrees.json"),
    JSON.stringify([{ path: real, branch, base_ref: "main", base_commit: head, created_at: 1, kind: "task", source_branch: "main" }]),
  );
  writeFileSync(join(real, "task.txt"), "agent\n");
  execFileSync("git", ["-C", real, "add", "-A"]);
  execFileSync("git", ["-C", real, "-c", "user.name=T", "-c", "user.email=t@e.x", "commit", "-q", "-m", "agent"]);
  return real;
}

describe("parity: worktree-merge-back-check", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  const check = (cwd, path, target) =>
    assertParity(dev, {
      command: "worktree-merge-back-check",
      args: { cwd, path, ...(target ? { target } : {}) },
      httpPath: "/api/worktree-merge-back-check",
      method: "POST",
      body: { cwd, path, target: target ?? null },
    });

  it("ready to merge back", async () => {
    const cwd = fixtureClean();
    await check(cwd, task(cwd, "ok"));
  });

  it("overlap with the main checkout", async () => {
    const cwd = fixtureClean();
    const path = task(cwd, "overlap");
    writeFileSync(join(cwd, "task.txt"), "mine\n");
    await check(cwd, path);
  });

  it("unknown target", async () => {
    const cwd = fixtureClean();
    await check(cwd, task(cwd, "t"), "nope");
  });

  it("main checkout on another branch", async () => {
    const cwd = fixtureClean();
    const path = task(cwd, "wb");
    execFileSync("git", ["-C", cwd, "checkout", "-q", "-b", "other"]);
    await check(cwd, path);
  });
});
