/**
 * Parity tests: `git_diff` (Rust) vs `/api/git-diff` (Node dev-server), for
 * the case where the requested path is a *directory* rather than a file.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * Why this file exists: the directory branch lived only in the dev-server for
 * several releases, so clicking an untracked folder worked under `dev:web` and
 * showed an empty panel in the packaged app (issue #183). Parity coverage is
 * what turns that class of drift into a red test instead of a bug report.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureUntrackedDirs } from "./fixtures.mjs";

describe("parity: git-diff on a directory", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a plain untracked folder lists the files inside it", async () => {
    const cwd = fixtureUntrackedDirs();
    const { rust, node } = await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "newdir/", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("newdir/")}`,
    });

    for (const side of [rust, node]) {
      expect(side.isDirectory).toBe(true);
      expect(side.hunks).toEqual([]);
      expect([...side.newFiles].sort()).toEqual(["newdir/e.txt", "newdir/sub/f.txt"]);
      expect(side.nestedRepo).toBeUndefined();
    }
  });

  it("a nested git repo is reported as such, with no file list", async () => {
    const cwd = fixtureUntrackedDirs();
    const { rust, node } = await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "inner/", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("inner/")}`,
    });

    for (const side of [rust, node]) {
      expect(side.isDirectory).toBe(true);
      expect(side.nestedRepo).toBe(true);
      // Its files belong to the other repo. Offering them here would produce
      // a row that reopens this same panel.
      expect(side.newFiles ?? []).toEqual([]);
    }
  });

  it("a modified file still produces a real diff", async () => {
    const cwd = fixtureUntrackedDirs();
    const { rust, node } = await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "README.md", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("README.md")}`,
    });

    for (const side of [rust, node]) {
      expect(side.isDirectory).toBeUndefined();
      expect(side.nestedRepo).toBeUndefined();
      expect(side.hunks.length).toBeGreaterThan(0);
    }
  });

  // Regression for a second drift this file caught: the dev-server ran its
  // `--no-index` fallback on any path with an empty `git diff`, so a tracked
  // file with nothing to show came back as an all-green whole-file addition.
  // The Rust side has always guarded that with `ls-files --error-unmatch`.
  it("a tracked file with no change reports no hunks on either side", async () => {
    const cwd = fixtureUntrackedDirs();
    const { rust, node } = await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "tracked.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("tracked.txt")}`,
    });

    expect(rust.hunks).toEqual([]);
    expect(node.hunks).toEqual([]);
  });
});
