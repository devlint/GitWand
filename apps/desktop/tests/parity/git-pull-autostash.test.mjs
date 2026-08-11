/**
 * Wire-contract test for `POST /api/git-pull`'s `autostash` field (issue #150).
 *
 * No Rust probe needed here — `git_pull`'s `autostash: Option<bool>` and this
 * dev-server route are two independent implementations of the same git
 * invocation, and this guards the `pnpm dev:web` path specifically (where
 * manual QA for #150 happens), same shape as scan-secrets.test.mjs.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { mkTempRepo, commitFile } from "./fixtures.mjs";

/** Adds a bare "origin" remote to `cwd` and pushes its current branch. */
function pushToNewRemote(cwd) {
  const remote = mkdtempSync(join(tmpdir(), "gw-pull-autostash-remote-"));
  execFileSync("git", ["init", "--bare", "--initial-branch=main", "--quiet", remote]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", cwd, "push", "-u", "origin", "main", "--quiet"]);
  return remote;
}

/** Clones `remote` into a fresh temp dir, configuring a stable identity. */
function cloneRemote(remote) {
  const dir = mkdtempSync(join(tmpdir(), "gw-pull-autostash-clone-"));
  execFileSync("git", ["clone", "--quiet", remote, "."], { cwd: dir });
  execFileSync("git", ["-C", dir, "config", "user.name", "GitWand Parity"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "parity@gitwand.test"]);
  return dir;
}

describe("dev-server wire contract: /api/git-pull autostash", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("autostash: true on a dirty tree succeeds and restores the WIP", async () => {
    const a = mkTempRepo("gw-pull-autostash-a-");
    commitFile(a, "base.txt", "base\n", "initial commit", 0);
    const remote = pushToNewRemote(a);

    const b = cloneRemote(remote);
    commitFile(b, "remote.txt", "remote change\n", "b: add remote.txt", 1);
    execFileSync("git", ["-C", b, "push", "--quiet"]);

    // Dirty, non-overlapping local edit in `a`.
    writeFileSync(join(a, "base.txt"), "base\nlocal edit\n", "utf-8");

    const res = await dev.fetch("/api/git-pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: a, strategy: "merge", autostash: true }),
    });
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(readFileSync(join(a, "base.txt"), "utf-8")).toContain("local edit");
    expect(readFileSync(join(a, "remote.txt"), "utf-8")).toBe("remote change\n");
    expect(execFileSync("git", ["-C", a, "stash", "list"], { encoding: "utf-8" }).trim()).toBe("");
  });

  it("autostash: false on a dirty tree still fails the way it does today", async () => {
    const a = mkTempRepo("gw-pull-autostash-fail-a-");
    commitFile(a, "base.txt", "base\n", "initial commit", 0);
    const remote = pushToNewRemote(a);

    const b = cloneRemote(remote);
    commitFile(b, "remote.txt", "remote change\n", "b: add remote.txt", 1);
    execFileSync("git", ["-C", b, "push", "--quiet"]);

    writeFileSync(join(a, "base.txt"), "base\nlocal edit\n", "utf-8");

    const res = await dev.fetch("/api/git-pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: a, strategy: "rebase", autostash: false }),
    });
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.message).toMatch(/cannot pull with rebase|unstaged changes|local changes/i);
  });

  it("autostash field absent behaves exactly like autostash: false", async () => {
    const a = mkTempRepo("gw-pull-autostash-absent-a-");
    commitFile(a, "base.txt", "base\n", "initial commit", 0);
    const remote = pushToNewRemote(a);

    const b = cloneRemote(remote);
    commitFile(b, "remote.txt", "remote change\n", "b: add remote.txt", 1);
    execFileSync("git", ["-C", b, "push", "--quiet"]);

    writeFileSync(join(a, "base.txt"), "base\nlocal edit\n", "utf-8");

    const res = await dev.fetch("/api/git-pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: a, strategy: "rebase" }),
    });
    const body = await res.json();

    expect(body.success).toBe(false);
  });
});
