/**
 * Parity tests: `git_file_lineage` (Rust, `src-tauri/src/combined/lineage.rs`)
 * vs `GET /api/git-file-lineage` (Node dev-server, `devFileLineage`).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity -- git-file-lineage`
 * (build the probe first: `cargo build --example parity-probe`).
 *
 * Scenarios: a history across renames, a merge, a repository opened from a
 * subdirectory, a literal pathspec, and the errors of invalid paths.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { mkTempRepo } from "./fixtures.mjs";

const COMMAND = "git-file-lineage";
const route = (cwd, path) => `/api/git-file-lineage?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;

function commitEnv(index) {
  const iso = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "GitWand Parity",
    GIT_AUTHOR_EMAIL: "parity@gitwand.test",
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: "GitWand Parity",
    GIT_COMMITTER_EMAIL: "parity@gitwand.test",
    GIT_COMMITTER_DATE: iso,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

const git = (cwd, args, index = 0) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: commitEnv(index) }).trim();

function commitFiles(cwd, files, message, index) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message, "-m", "a body that is not shipped"], index);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("parity: git-file-lineage", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  const repos = [];
  const repo = (label) => {
    const cwd = mkTempRepo(`gw-parity-lineage-${label}-`);
    repos.push(cwd);
    return cwd;
  };

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
    for (const cwd of repos) rmSync(cwd, { recursive: true, force: true });
  });

  const parity = (cwd, path) => assertParity(dev, { command: COMMAND, args: { cwd, path }, httpPath: route(cwd, path) });

  it("follows a file across renames, newest first, with its name at each commit", async () => {
    const cwd = repo("rename");
    const c1 = commitFiles(cwd, { "dir/a.txt": "1\n" }, "one", 0);
    commitFiles(cwd, { other: "o\n" }, "unrelated", 1);
    git(cwd, ["mv", "dir/a.txt", "b.txt"]);
    git(cwd, ["commit", "-q", "-m", "rename"], 2);
    const c2 = git(cwd, ["rev-parse", "HEAD"]);
    const c3 = commitFiles(cwd, { "b.txt": "2\n" }, "edit", 3);
    const { rust } = await parity(cwd, "b.txt");
    expect(rust).toEqual([
      { hash: c3, path: "b.txt" },
      { hash: c2, path: "b.txt" },
      { hash: c1, path: "dir/a.txt" },
    ]);
  });

  it("a history through a merge", async () => {
    const cwd = repo("merge");
    commitFiles(cwd, { f: "a\n", g: "g\n" }, "base", 0);
    git(cwd, ["checkout", "-q", "-b", "side"]);
    commitFiles(cwd, { f: "a\nb\n" }, "side", 1);
    git(cwd, ["checkout", "-q", "main"]);
    commitFiles(cwd, { f: "z\na\n" }, "main", 2);
    git(cwd, ["merge", "-q", "--no-ff", "side", "-m", "merge"], 3);
    const { rust } = await parity(cwd, "f");
    expect(rust.length).toBeGreaterThanOrEqual(3);
  });

  it("a repository opened from a subdirectory reads root-relative paths", async () => {
    const cwd = repo("subdir");
    const c = commitFiles(cwd, { "sub/x": "1\n" }, "x", 0);
    const { rust } = await parity(join(cwd, "sub"), "sub/x");
    expect(rust).toEqual([{ hash: c, path: "sub/x" }]);
  });

  it("the path is literal, not a glob", async () => {
    const cwd = repo("literal");
    commitFiles(cwd, { a1: "1\n", "a*": "2\n" }, "a", 0);
    const { rust } = await parity(cwd, "a*");
    expect(rust.map((e) => e.path)).toEqual(["a*"]);
  });

  it("invalid paths fail with the same message on both sides", async () => {
    const cwd = repo("errors");
    commitFiles(cwd, { f: "1\n" }, "f", 0);
    const cases = [
      ["../x", "path must not contain `..` (got: ../x)"],
      ["/etc/passwd", "path must be relative to the repo (got: /etc/passwd)"],
      [" ", "path must not be empty"],
      ["./f", "path must not have an empty or `.` component (got: ./f)"],
    ];
    for (const [path, message] of cases) {
      const probe = runProbe(COMMAND, { cwd, path });
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe(message);
      const res = await dev.fetch(route(cwd, path));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(message);
    }
  });
});
