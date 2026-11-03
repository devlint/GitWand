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
import { writeFileSync } from "node:fs";
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
});
