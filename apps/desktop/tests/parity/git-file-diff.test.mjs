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
import { rmSync, writeFileSync } from "node:fs";
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

  /** Both backends refuse, with the same message. */
  async function assertBothRefuse(cwd, path, fromHash, toHash, messagePart) {
    const probe = runProbe("command-parity", {
      command: "git_file_diff",
      args: { cwd, path, fromHash, toHash },
    });
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(call(cwd, path, fromHash, toHash).httpPath);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(probe.error);
    expect(body.error).toContain(messagePart);
  }

  it("both refuse a revision git would read as an option", async () => {
    await assertBothRefuse(h.cwd, "f.txt", "--output=/tmp/x", h.added, "invalid fromHash");
  });

  it("both refuse an empty or whitespace-only revision", async () => {
    await assertBothRefuse(h.cwd, "f.txt", "   ", h.added, "fromHash must not be empty");
    await assertBothRefuse(h.cwd, "f.txt", h.added, "", "toHash must not be empty");
  });

  it("both refuse the repository root as the path", async () => {
    await assertBothRefuse(h.cwd, ".", h.added, h.edited, "repository root");
  });

  it("both report an unknown revision as an error, not as an empty diff", async () => {
    const bad = "0000000000000000000000000000000000000bad";
    await assertBothRefuse(h.cwd, "f.txt", h.added, bad, "unknown revision");
  });
});

describe("parity: git-file-diff across a rename", () => {
  let dev;
  let r;

  /** `old.txt` edited twice, renamed to `new.txt`, edited again. */
  function fixtureRenamed() {
    const cwd = mkTempRepo("gw-parity-file-diff-rename-");
    const ten = (two, last) => `1\n${two}\n3\n4\n5\n6\n7\n8\n9\n${last}\n`;
    commitFile(cwd, "old.txt", ten("2", "10"), "a1", 0);
    commitFile(cwd, "old.txt", ten("TWO", "10"), "a2", 1);
    execFileSync("git", ["-C", cwd, "mv", "old.txt", "new.txt"]);
    execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "rename"]);
    commitFile(cwd, "new.txt", ten("TWO", "TEN"), "b", 3);
    return { cwd, a1: rev(cwd, "HEAD~3"), a2: rev(cwd, "HEAD~2"), b: rev(cwd, "HEAD") };
  }

  const changed = (d) => d.hunks.flatMap((x) => x.lines).filter((l) => l.type !== "context");

  beforeAll(async () => {
    dev = await startDevServer();
    r = fixtureRenamed();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("two commits both before the rename diff the old name", async () => {
    const { node } = await assertParity(dev, call(r.cwd, "new.txt", r.a1, r.a2));
    expect(changed(node).map((l) => [l.type, l.content])).toEqual([["delete", "2"], ["add", "TWO"]]);
  });

  it("one commit on each side diffs the content, not 'everything added'", async () => {
    const { node } = await assertParity(dev, call(r.cwd, "new.txt", r.a2, r.b));
    expect(changed(node).map((l) => [l.type, l.content])).toEqual([["delete", "10"], ["add", "TEN"]]);
  });
});

describe("parity: git-file-diff path handling", () => {
  let dev;
  beforeAll(async () => { dev = await startDevServer(); }, 15_000);
  afterAll(async () => { await dev?.stop(); });

  /** `name` and a decoy a pathspec reading of `name` would also match. */
  function fixtureLiteral(name, decoy) {
    const cwd = mkTempRepo("gw-parity-file-diff-literal-");
    // `commitFile` stages with a pathspec, which would read `:x.txt` as magic.
    const commit = (p, content, msg) => {
      writeFileSync(join(cwd, p), content);
      execFileSync("git", ["-C", cwd, "--literal-pathspecs", "add", "--", p]);
      execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", msg]);
    };
    commit(decoy, "decoy\n", "decoy");
    commit(name, "real\n", "a");
    commit(decoy, "decoy changed\n", "decoy edit");
    commit(name, "real changed\n", "b");
    return { cwd, a: rev(cwd, "HEAD~2"), b: rev(cwd, "HEAD") };
  }

  for (const [name, decoy] of [["a[1].txt", "a1.txt"], [":x.txt", "x.txt"]]) {
    it(`"${name}" is a literal name, not a pathspec matching "${decoy}"`, async () => {
      const f = fixtureLiteral(name, decoy);
      const { node } = await assertParity(dev, call(f.cwd, name, f.a, f.b));
      expect(node.hunks.flatMap((x) => x.lines).map((l) => [l.type, l.content])).toEqual([
        ["delete", "real"],
        ["add", "real changed"],
      ]);
    });
  }

  it("a ./-prefixed path is normalised and echoed as given", async () => {
    const f = fixtureLiteral("f.txt", "g.txt");
    const { node } = await assertParity(dev, call(f.cwd, "./f.txt", f.a, f.b));
    expect(node.path).toBe("./f.txt");
    expect(node.hunks.length).toBe(1);
  });
});
