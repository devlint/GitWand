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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function call(cwd, path, fromHash, toHash, fromPath, toPath) {
  const params = new URLSearchParams({ cwd, path, from: fromHash, to: toHash });
  const args = { cwd, path, fromHash, toHash };
  if (fromPath !== undefined) { params.set("fromPath", fromPath); args.fromPath = fromPath; }
  if (toPath !== undefined) { params.set("toPath", toPath); args.toPath = toPath; }
  return {
    command: "command-parity",
    args: { command: "git_file_diff", args },
    httpPath: `/api/git-file-diff?${params}`,
  };
}

function logCall(cwd, path) {
  return {
    command: "command-parity",
    args: { command: "git_file_log", args: { cwd, path } },
    httpPath: `/api/git-file-log?${new URLSearchParams({ cwd, path })}`,
  };
}

/**
 * What the viewer does: read the file log (asserting both backends agree on
 * it, names included), then diff with the two entries' names.
 */
async function compareLikeTheViewer(dev, cwd, path, fromHash, toHash) {
  const { node: log } = await assertParity(dev, logCall(cwd, path));
  const name = (h) => log.find((e) => e.hashFull === h)?.path;
  return assertParity(dev, call(cwd, path, fromHash, toHash, name(fromHash), name(toHash)));
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

  it("the file log names the file at each commit, old name before the rename", async () => {
    const { node } = await assertParity(dev, logCall(r.cwd, "new.txt"));
    expect(node.map((e) => [e.hashFull, e.path])).toEqual([
      [r.b, "new.txt"],
      [rev(r.cwd, "HEAD~1"), "new.txt"],
      [r.a2, "old.txt"],
      [r.a1, "old.txt"],
    ]);
  });

  it("two commits both before the rename diff the old name", async () => {
    const { node } = await compareLikeTheViewer(dev, r.cwd, "new.txt", r.a1, r.a2);
    expect(changed(node).map((l) => [l.type, l.content])).toEqual([["delete", "2"], ["add", "TWO"]]);
  });

  it("one commit on each side diffs the content, not 'everything added'", async () => {
    const { node } = await compareLikeTheViewer(dev, r.cwd, "new.txt", r.a2, r.b);
    expect(changed(node).map((l) => [l.type, l.content])).toEqual([["delete", "10"], ["add", "TEN"]]);
  });

  it("opened from a subdirectory, the log's root-relative names still resolve", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-subdir-");
    commitFile(cwd, "sub/old.txt", "1\n2\n3\n", "a1", 0);
    execFileSync("git", ["-C", cwd, "mv", "sub/old.txt", "sub/new.txt"]);
    execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "rename"]);
    commitFile(cwd, "sub/new.txt", "1\n2\nTHREE\n", "b", 2);
    const sub = join(cwd, "sub");
    const { node } = await compareLikeTheViewer(dev, sub, "new.txt", rev(cwd, "HEAD~2"), rev(cwd, "HEAD"));
    expect(changed(node).map((l) => [l.type, l.content])).toEqual([["delete", "3"], ["add", "THREE"]]);
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
      mkdirSync(dirname(join(cwd, p)), { recursive: true });
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
      const { node } = await compareLikeTheViewer(dev, f.cwd, name, f.a, f.b);
      expect(node.hunks.flatMap((x) => x.lines).map((l) => [l.type, l.content])).toEqual([
        ["delete", "real"],
        ["add", "real changed"],
      ]);
    });

    it(`the file log of "${name}" does not list "${decoy}"'s commits`, async () => {
      const f = fixtureLiteral(name, decoy);
      const { node } = await assertParity(dev, logCall(f.cwd, name));
      expect(node.map((e) => e.message)).toEqual(["b", "a"]);
      expect(node.every((e) => e.path === name)).toBe(true);
    });
  }

  it("a ./-prefixed path is normalised and echoed as given", async () => {
    const f = fixtureLiteral("f.txt", "g.txt");
    const { node } = await assertParity(dev, call(f.cwd, "./f.txt", f.a, f.b));
    expect(node.path).toBe("./f.txt");
    expect(node.hunks.length).toBe(1);
  });

  it("both refuse a directory", async () => {
    const f = fixtureLiteral("dir/f.txt", "g.txt");
    const probe = runProbe("command-parity", {
      command: "git_file_diff",
      args: { cwd: f.cwd, path: "dir", fromHash: f.a, toHash: f.b },
    });
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(call(f.cwd, "dir", f.a, f.b).httpPath);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(probe.error);
    expect(probe.error).toContain("directory");
  });

  it("both refuse a side path at the repository root", async () => {
    const f = fixtureLiteral("f.txt", "g.txt");
    const probe = runProbe("command-parity", {
      command: "git_file_diff",
      args: { cwd: f.cwd, path: "f.txt", fromHash: f.a, toHash: f.b, toPath: "." },
    });
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(call(f.cwd, "f.txt", f.a, f.b, undefined, ".").httpPath);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(probe.error);
  });
});

describe("parity: git-file-diff, third pass", () => {
  let dev;
  beforeAll(async () => { dev = await startDevServer(); }, 15_000);
  afterAll(async () => { await dev?.stop(); });

  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  /** Commit `p` (any name: staged with a literal pathspec). */
  const commit = (cwd, p, content, msg) => {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), content);
    git(cwd, "--literal-pathspecs", "add", "--", p);
    git(cwd, "commit", "--quiet", "-m", msg);
    return rev(cwd, "HEAD");
  };

  /** Both backends refuse, with the same message. */
  async function refusedAlike(c) {
    const probe = runProbe(c.command, c.args);
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(c.httpPath);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(probe.error);
    return probe.error;
  }

  it("a file absent from both commits is an error on both sides", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-absent-");
    const a = commit(cwd, "f.txt", "x\n", "a");
    const b = commit(cwd, "f.txt", "y\n", "b");
    expect(await refusedAlike(call(cwd, "never.txt", a, b))).toBe("never.txt not found at either commit");
  });

  it("a control character in a revision is refused alike", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-ctrl-");
    const a = commit(cwd, "f.txt", "x\n", "a");
    expect(await refusedAlike(call(cwd, "f.txt", `${a}\nHEAD`, a))).toContain("invalid fromHash");
  });

  it("the unknown revision is named alike, whichever side it is", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-unknown-");
    const a = commit(cwd, "f.txt", "x\n", "a");
    expect(await refusedAlike(call(cwd, "f.txt", a, "nada"))).toBe("unknown revision: nada");
  });

  it("side paths are checked lexically, with the same messages", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-lexical-");
    const a = commit(cwd, "f.txt", "x\n", "a");
    for (const p of ["../x", "/etc/passwd", "./"]) {
      await refusedAlike(call(cwd, "f.txt", a, a, p));
    }
  });

  it("an old name under a directory that is now a symlink out of the repo is still read", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-symlink-");
    const a = commit(cwd, "assets/logo.txt", "v1\n", "a");
    git(cwd, "mv", "assets/logo.txt", "logo.txt");
    git(cwd, "commit", "--quiet", "-m", "move");
    const b = commit(cwd, "logo.txt", "v2\n", "b");
    const outside = mkTempRepo("gw-parity-outside-");
    rmSync(join(cwd, "assets"), { recursive: true, force: true });
    symlinkSync(outside, join(cwd, "assets"));
    const { node } = await compareLikeTheViewer(dev, cwd, "logo.txt", a, b);
    expect(node.hunks.flatMap((h) => h.lines).map((l) => [l.type, l.content])).toEqual([
      ["delete", "v1"],
      ["add", "v2"],
    ]);
  });

  it("diff.relative does not make the log's names relative to a subdirectory cwd", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-relative-");
    const a = commit(cwd, "sub/old.txt", "1\n2\n", "a");
    git(cwd, "mv", "sub/old.txt", "sub/new.txt");
    git(cwd, "commit", "--quiet", "-m", "rename");
    const b = commit(cwd, "sub/new.txt", "1\nTWO\n", "b");
    git(cwd, "config", "diff.relative", "true");
    const sub = join(cwd, "sub");
    const { node: log } = await assertParity(dev, logCall(sub, "new.txt"));
    expect(log.map((e) => e.path)).toEqual(["sub/new.txt", "sub/new.txt", "sub/old.txt"]);
    const { node } = await compareLikeTheViewer(dev, sub, "new.txt", a, b);
    expect(node.hunks.length).toBe(1);
  });

  it("a name starting with a newline and holding a 0x1e survives log and diff", async () => {
    const cwd = mkTempRepo("gw-parity-file-diff-oddname-");
    const name = "\nodd\x1ename.txt";
    const a = commit(cwd, name, "a\n", "a");
    const b = commit(cwd, name, "b\n", "b");
    const { node: log } = await assertParity(dev, logCall(cwd, name));
    expect(log.map((e) => e.path)).toEqual([name, name]);
    const { node } = await compareLikeTheViewer(dev, cwd, name, a, b);
    expect(node.hunks.flatMap((h) => h.lines).map((l) => [l.type, l.content])).toEqual([
      ["delete", "a"],
      ["add", "b"],
    ]);
  });
});

describe("parity: git-file-log failures", () => {
  let dev;
  beforeAll(async () => { dev = await startDevServer(); }, 15_000);
  afterAll(async () => { await dev?.stop(); });

  it("a failing log is an error on both sides, never an empty history", async () => {
    // A directory that is not a repository: git log exits non-zero.
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "gw-parity-not-a-repo-")));
    const probe = runProbe("command-parity", {
      command: "git_file_log",
      args: { cwd: notARepo, path: "f.txt" },
    });
    expect(probe.ok).toBe(false);
    const res = await dev.fetch(logCall(notARepo, "f.txt").httpPath);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(probe.error);
    expect(body.error).toMatch(/^git log failed: /);
  });
});

// A removed `-- x` is the diff line `--- x`, an added `++x` is `+++x`; with
// `diff.suppressBlankEmpty=true` a blank context line is "". Each belongs to
// the hunk, in the plain pathspec form and in the blob-to-blob (renamed) one.
describe("parity: git-file-diff, lines that look like headers", () => {
  let dev;
  beforeAll(async () => { dev = await startDevServer(); }, 15_000);
  afterAll(async () => { await dev?.stop(); });

  const BEFORE = "SELECT 1;\n-- x\n\nSELECT 2;\n--- x\nSELECT 3;\n";
  const AFTER = "SELECT 1;\n++x\n\nSELECT 2;\n+++ y\nSELECT 3;\n";
  const EXPECTED = [
    ["context", "SELECT 1;", 1, 1],
    ["delete", "-- x", 2, null],
    ["add", "++x", null, 2],
    ["context", "", 3, 3],
    ["context", "SELECT 2;", 4, 4],
    ["delete", "--- x", 5, null],
    ["add", "+++ y", null, 5],
    ["context", "SELECT 3;", 6, 6],
  ];
  const shape = (d) => d.hunks.flatMap((h) => h.lines).map((l) => [l.type, l.content, l.oldLineNo, l.newLineNo]);
  const suppressBlank = (cwd) => execFileSync("git", ["-C", cwd, "config", "diff.suppressBlankEmpty", "true"]);

  for (const suppress of [false, true]) {
    const label = suppress ? "with diff.suppressBlankEmpty" : "default config";

    it(`plain form keeps them (${label})`, async () => {
      const cwd = mkTempRepo("gw-parity-file-diff-dash-");
      if (suppress) suppressBlank(cwd);
      commitFile(cwd, "q.sql", BEFORE, "a", 0);
      commitFile(cwd, "q.sql", AFTER, "b", 1);
      const [a, b] = [rev(cwd, "HEAD~1"), rev(cwd, "HEAD")];
      if (suppress) {
        const raw = execFileSync("git", ["-C", cwd, "diff", a, b, "--", "q.sql"], { encoding: "utf-8" });
        expect(raw).toContain("\n+++x\n\n SELECT 2;"); // git really printed ""
      }
      const { rust, node } = await assertParity(dev, call(cwd, "q.sql", a, b));
      for (const side of [rust, node]) {
        expect(side.hunks).toHaveLength(1);
        expect(shape(side)).toEqual(EXPECTED);
      }
    });

    it(`blob-to-blob form across a rename keeps them (${label})`, async () => {
      const cwd = mkTempRepo("gw-parity-file-diff-dash-rename-");
      if (suppress) suppressBlank(cwd);
      commitFile(cwd, "old.sql", BEFORE, "a", 0);
      execFileSync("git", ["-C", cwd, "mv", "old.sql", "new.sql"]);
      execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "rename"]);
      commitFile(cwd, "new.sql", AFTER, "b", 2);
      const [a, b] = [rev(cwd, "HEAD~2"), rev(cwd, "HEAD")];
      if (suppress) {
        const raw = execFileSync("git", ["-C", cwd, "diff", `${a}:old.sql`, `${b}:new.sql`], { encoding: "utf-8" });
        expect(raw).toContain("\n+++x\n\n SELECT 2;");
      }
      const { rust, node } = await assertParity(dev, call(cwd, "new.sql", a, b, "old.sql", "new.sql"));
      for (const side of [rust, node]) {
        expect(side.hunks).toHaveLength(1);
        expect(shape(side)).toEqual(EXPECTED);
      }
    });
  }
});
