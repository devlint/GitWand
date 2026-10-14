/**
 * Parity tests: `git_file_diff` (Rust) vs `/api/git-file-diff` (Node dev-server).
 *
 * The file history viewer's compare tab invoked `git_file_diff` long before
 * the Rust command existed: `dev:web` answered through the route, the desktop
 * app failed. These cases keep the two backends answering the same thing.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * (needs `cargo build --example parity-probe` first, see README.md).
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { commitFile, mkTempRepo } from "./fixtures.mjs";

const rev = (cwd, ref) =>
  execFileSync("git", ["-C", cwd, "rev-parse", ref], { encoding: "utf-8" }).trim();

/**
 * History of `f.txt`: created (with a blank line, which must stay a context
 * line on both sides), edited in two places, then deleted. `other.txt` changes
 * in between so a diff that leaks past the pathspec would show.
 */
function fixtureFileHistory() {
  const cwd = mkTempRepo("gw-parity-file-diff-");
  commitFile(cwd, "seed.txt", "seed\n", "root", 0);
  commitFile(cwd, "f.txt", "one\ntwo\n\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n", "add f", 1);
  commitFile(cwd, "other.txt", "noise\n", "unrelated", 2);
  commitFile(cwd, "f.txt", "one\nTWO\n\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n", "edit f", 3);
  rmSync(join(cwd, "f.txt"));
  execFileSync("git", ["-C", cwd, "rm", "--quiet", "--", "f.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "delete f"], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-01T00:00:04Z",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:04Z",
    },
  });
  return {
    cwd,
    root: rev(cwd, "HEAD~4"),
    added: rev(cwd, "HEAD~3"),
    edited: rev(cwd, "HEAD~1"),
    deleted: rev(cwd, "HEAD"),
  };
}

function call(cwd, path, fromHash, toHash) {
  return {
    command: "command-parity",
    args: { command: "git_file_diff", args: { cwd, path, fromHash, toHash } },
    httpPath:
      `/api/git-file-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}` +
      `&from=${encodeURIComponent(fromHash)}&to=${encodeURIComponent(toHash)}`,
  };
}

describe("parity: git-file-diff", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  let h;

  beforeAll(async () => {
    dev = await startDevServer();
    h = fixtureFileHistory();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("an edit between two commits gives identical hunks and line numbers", async () => {
    const { node } = await assertParity(dev, call(h.cwd, "f.txt", h.added, h.edited));
    expect(node.path).toBe("f.txt");
    expect(node.hunks.length).toBe(2);
    const types = node.hunks[0].lines.map((l) => l.type);
    expect(types).toEqual(["context", "delete", "add", "context", "context", "context"]);
    expect(node.hunks[0].lines[3]).toEqual({ type: "context", content: "", oldLineNo: 3, newLineNo: 3 });
  });

  it("the file absent at the older commit comes back as all additions", async () => {
    const { node } = await assertParity(dev, call(h.cwd, "f.txt", h.root, h.added));
    expect(node.hunks[0].lines.every((l) => l.type === "add")).toBe(true);
    expect(node.hunks[0].oldStart).toBe(0);
  });

  it("the file deleted since (missing from the working tree) diffs as all deletions", async () => {
    const { node } = await assertParity(dev, call(h.cwd, "f.txt", h.edited, h.deleted));
    expect(node.hunks[0].lines.every((l) => l.type === "delete")).toBe(true);
  });

  it("a commit range that does not touch the file gives no hunks", async () => {
    const { node } = await assertParity(dev, call(h.cwd, "f.txt", h.added, rev(h.cwd, "HEAD~2")));
    expect(node).toEqual({ path: "f.txt", hunks: [] });
  });

  it("both refuse a revision git would read as an option", async () => {
    const probe = runProbe("command-parity", {
      command: "git_file_diff",
      args: { cwd: h.cwd, path: "f.txt", fromHash: "--output=/tmp/x", toHash: h.added },
    });
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(call(h.cwd, "f.txt", "--output=/tmp/x", h.added).httpPath);
    expect(res.status).toBe(400);
  });

  it("both report an unknown revision as an error, not as an empty diff", async () => {
    const bad = "0000000000000000000000000000000000000bad";
    const probe = runProbe("command-parity", {
      command: "git_file_diff",
      args: { cwd: h.cwd, path: "f.txt", fromHash: h.added, toHash: bad },
    });
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(call(h.cwd, "f.txt", h.added, bad).httpPath);
    expect(res.status).toBe(500);
  });
});
