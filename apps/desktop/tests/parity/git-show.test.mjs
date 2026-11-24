/**
 * Parity tests: `git_show` (Rust) vs `/api/git-show` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * `git show` parses a multi-file diff, so it is where a hunk line that looks
 * like a file header hurts most: a removed `-- x` is the diff line `--- x`,
 * an added `++x` is `+++x`. Both parsers used to drop them as `---`/`+++`
 * headers; the next file's real headers must still parse.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { commitFile, mkTempRepo } from "./fixtures.mjs";

describe("parity: git-show", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a multi-file commit keeps hunk lines starting with -- or ++, and every file header", async () => {
    const cwd = mkTempRepo("gw-parity-show-dashdash-");
    commitFile(cwd, "a.txt", "a\n", "a", 0);
    commitFile(cwd, "q.sql", "SELECT 1;\n-- old comment\nSELECT 2;\n--- x\nSELECT 3;\n", "q", 1);
    commitFile(cwd, "z.txt", "one\ntwo\n", "z", 2);
    writeFileSync(join(cwd, "a.txt"), "a\n--- not a header\n");
    writeFileSync(join(cwd, "q.sql"), "SELECT 1;\n++x\nSELECT 2;\n+++ y\nSELECT 3;\n");
    writeFileSync(join(cwd, "z.txt"), "one\n++ two\n");
    writeFileSync(join(cwd, "new.sql"), "-- created\n++ too\n");
    execFileSync("git", ["-C", cwd, "add", "-A"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "edit"]);

    const { rust, node } = await assertParity(dev, {
      command: "git-show",
      args: { cwd, hash: "HEAD" },
      httpPath: `/api/git-show?cwd=${encodeURIComponent(cwd)}&hash=HEAD`,
    });

    for (const side of [rust, node]) {
      const byPath = Object.fromEntries(side.map((d) => [d.path, d]));
      expect(Object.keys(byPath).sort()).toEqual(["a.txt", "new.sql", "q.sql", "z.txt"]);
      const shape = (p) => byPath[p].hunks.flatMap((h) => h.lines.map((l) => [l.type, l.content]));
      expect(shape("a.txt")).toEqual([["context", "a"], ["add", "--- not a header"]]);
      expect(shape("q.sql")).toEqual([
        ["context", "SELECT 1;"],
        ["delete", "-- old comment"],
        ["add", "++x"],
        ["context", "SELECT 2;"],
        ["delete", "--- x"],
        ["add", "+++ y"],
        ["context", "SELECT 3;"],
      ]);
      expect(shape("z.txt")).toEqual([["context", "one"], ["delete", "two"], ["add", "++ two"]]);
      expect(byPath["new.sql"].status).toBe("added");
      expect(shape("new.sql")).toEqual([["add", "-- created"], ["add", "++ too"]]);
    }
  });

  // `Binary files … differ` sets `binary: true` on that file only.
  it("flags a binary file, and only it", async () => {
    const cwd = mkTempRepo("gw-parity-show-binary-");
    commitFile(cwd, "t.txt", "t\n", "t", 0);
    writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(cwd, "t.txt"), "t2\n");
    execFileSync("git", ["-C", cwd, "add", "-A"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "bin"]);

    const { rust, node } = await assertParity(dev, {
      command: "git-show",
      args: { cwd, hash: "HEAD" },
      httpPath: `/api/git-show?cwd=${encodeURIComponent(cwd)}&hash=HEAD`,
    });
    for (const side of [rust, node]) {
      expect(side.filter((d) => d.binary === true).map((d) => d.path)).toEqual(["bin.dat"]);
      expect(side.find((d) => d.path === "t.txt").binary).toBeUndefined();
    }
  });

  // Both backends split git's output like Rust's `str::lines()`: a CRLF
  // file's lines lose their `\r`, on both sides.
  it("a CRLF file parses like Rust's lines()", async () => {
    const cwd = mkTempRepo("gw-parity-show-crlf-");
    commitFile(cwd, "w.txt", "a\r\nb\r\n", "w", 0);
    writeFileSync(join(cwd, "w.txt"), "a\r\nB\r\n");
    execFileSync("git", ["-C", cwd, "commit", "-q", "-am", "edit"]);

    const { rust, node } = await assertParity(dev, {
      command: "git-show",
      args: { cwd, hash: "HEAD" },
      httpPath: `/api/git-show?cwd=${encodeURIComponent(cwd)}&hash=HEAD`,
    });
    for (const side of [rust, node]) {
      expect(side[0].hunks[0].lines.map((l) => [l.type, l.content])).toEqual([
        ["context", "a"],
        ["delete", "b"],
        ["add", "B"],
      ]);
    }
  });

  // `diff.suppressBlankEmpty=true` prints a blank context line as "": inside
  // a hunk (counts left on both sides) it is a context line.
  it("counts a suppressed blank context line, and the next file still parses", async () => {
    const cwd = mkTempRepo("gw-parity-show-blank-");
    execFileSync("git", ["-C", cwd, "config", "diff.suppressBlankEmpty", "true"]);
    commitFile(cwd, "f.txt", "a\n\nb\n", "f", 0);
    commitFile(cwd, "g.txt", "x\n", "g", 1);
    writeFileSync(join(cwd, "f.txt"), "a\n\nB\n");
    writeFileSync(join(cwd, "g.txt"), "y\n");
    execFileSync("git", ["-C", cwd, "commit", "-q", "-am", "edit"]);

    const { rust, node } = await assertParity(dev, {
      command: "git-show",
      args: { cwd, hash: "HEAD" },
      httpPath: `/api/git-show?cwd=${encodeURIComponent(cwd)}&hash=HEAD`,
    });
    for (const side of [rust, node]) {
      expect(side.map((d) => d.path)).toEqual(["f.txt", "g.txt"]);
      expect(side[0].hunks[0].lines.map((l) => [l.type, l.content, l.oldLineNo, l.newLineNo])).toEqual([
        ["context", "a", 1, 1],
        ["context", "", 2, 2],
        ["delete", "b", 3, null],
        ["add", "B", null, 3],
      ]);
      expect(side[1].hunks[0].lines.map((l) => [l.type, l.content])).toEqual([["delete", "x"], ["add", "y"]]);
    }
  });

  // A name holding ` b/` and names git C-quotes (`"`, `\\`, a tab, non-ASCII
  // with the default core.quotePath=true) come out exactly as git stores them.
  it.skipIf(process.platform === "win32")("names files with ` b/`, quotes, escapes and non-ASCII exactly", async () => {
    const cwd = mkTempRepo("gw-parity-show-names-");
    const names = ["plan b/f.txt", 'we"ird.txt', "ta\tb.txt", "back\\slash.txt", "é.txt"];
    names.forEach((n, i) => commitFile(cwd, n, "1\n", n, i));
    for (const n of names.slice(0, 4)) writeFileSync(join(cwd, n), "2\n");
    mkdirSync(join(cwd, "è b"));
    execFileSync("git", ["-C", cwd, "mv", "é.txt", "è b/é.txt"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-am", "edit"]);

    const { rust, node } = await assertParity(dev, {
      command: "git-show",
      args: { cwd, hash: "HEAD" },
      httpPath: `/api/git-show?cwd=${encodeURIComponent(cwd)}&hash=HEAD`,
    });
    for (const side of [rust, node]) {
      expect(side.map((d) => [d.path, d.oldPath ?? null]).sort()).toEqual(
        [
          ["back\\slash.txt", null],
          ["plan b/f.txt", null],
          ["ta\tb.txt", null],
          ["we\"ird.txt", null],
          ["è b/é.txt", "é.txt"],
        ].sort(),
      );
    }
  });
});
