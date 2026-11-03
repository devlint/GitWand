/**
 * Parity tests: `git_diff` (Rust) vs `/api/git-diff` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * Two things are guarded here, both of which have already drifted once:
 *
 *  - The v3.10.0 libgit2 fast path must be indistinguishable from the CLI
 *    output the dev-server produces.
 *  - The *directory* branch lived only in the dev-server for several
 *    releases, so clicking an untracked folder worked under `dev:web` and
 *    showed an empty panel in the packaged app (issue #183). It also has to
 *    keep short-circuiting ahead of the libgit2 path, which cannot diff a
 *    directory.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { commitFile, fixtureDiff, fixtureUntrackedDirs, mkTempRepo } from "./fixtures.mjs";

describe("parity: git-diff", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("unstaged edit produces identical hunks", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "a.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=a.txt&staged=false`,
    });
  });

  it("staged edit produces identical hunks", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "b.txt", staged: true },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=b.txt&staged=true`,
    });
  });

  it("clean file produces no hunks on either side", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "b.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=b.txt&staged=false`,
    });
  });

  describe("on a directory", () => {
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

  // The untracked fallback runs `git diff --no-index -- /dev/null <path>`,
  // which reads any file it is handed. Neither backend validated `path`, so
  // `../secret` rendered a file outside the repository.
  describe("path boundary", () => {
    const SECRET = "outside-secret-content";

    it("a `../` or absolute path outside the repo is refused by both, with the same message", async () => {
      const cwd = mkTempRepo("gw-parity-diff-escape-");
      commitFile(cwd, "a.txt", "a\n", "init", 0);
      const outside = join(cwd, "..", `${basename(cwd)}-outside.txt`);
      writeFileSync(outside, `${SECRET}\n`);
      try {
        for (const path of [`../${basename(outside)}`, outside]) {
          const rust = runProbe("git-diff", { cwd, path, staged: false });
          const res = await dev.fetch(
            `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=false`,
          );
          const node = await res.json();

          expect(rust.ok, `rust must not diff ${path}`).toBe(false);
          expect(res.status, `node must refuse ${path}`).toBe(400);
          expect(rust.error).toMatch(/^path escapes cwd/);
          expect(node.error).toBe(rust.error);
          expect(JSON.stringify(node)).not.toContain(SECRET);
        }
      } finally {
        rmSync(outside, { force: true });
      }
    });

    /** Rust and Node on the same path: both must refuse, with one message. */
    async function bothRefuse(cwd, path) {
      const rust = runProbe("git-diff", { cwd, path, staged: false });
      const res = await dev.fetch(
        `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=false`,
      );
      const node = await res.json();
      expect(rust.ok, `rust must refuse ${path}`).toBe(false);
      expect(res.status, `node must refuse ${path}`).toBe(400);
      expect(node.error, path).toBe(rust.error);
      expect(JSON.stringify(node)).not.toContain(SECRET);
      return rust.error;
    }

    // `linkdir/..` is the parent of the link's TARGET. Folding `..` lexically
    // judged `linkdir/../secret` as the repo's own `secret`, then handed the
    // raw path to `git diff --no-index`, which followed the link and read the
    // file outside.
    it("`..` after a symlink leading outside is refused by both", async () => {
      const cwd = mkTempRepo("gw-parity-diff-linkdotdot-");
      commitFile(cwd, "a.txt", "a\n", "init", 0);
      const out = `${cwd}-out`;
      mkdirSync(join(out, "sub"), { recursive: true });
      writeFileSync(join(out, "secret"), `${SECRET}\n`);
      writeFileSync(join(cwd, "secret"), "in-repo\n");
      symlinkSync(join(out, "sub"), join(cwd, "linkdir"));
      try {
        for (const path of ["linkdir/../secret", "linkdir/newfile"]) {
          expect(await bothRefuse(cwd, path)).toMatch(/^path escapes cwd/);
        }
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });

    it("paths below a dangling or looping symlink are refused by both", async () => {
      const cwd = mkTempRepo("gw-parity-diff-dangling-");
      commitFile(cwd, "a.txt", "a\n", "init", 0);
      symlinkSync(join(`${cwd}-nowhere`, "x"), join(cwd, "dangling"));
      symlinkSync(join(cwd, "loop"), join(cwd, "loop"));
      for (const path of ["dangling/x", "loop/x"]) {
        expect(await bothRefuse(cwd, path)).toMatch(/^path does not resolve: .* \(dangling, looping or unreadable component\)$/);
      }
    });

    it("`..` below a missing directory is refused by both, with the same message", async () => {
      const cwd = mkTempRepo("gw-parity-diff-missingdotdot-");
      commitFile(cwd, "a.txt", "a\n", "init", 0);
      for (const path of ["gone/../a.txt", "missing/../../x"]) {
        expect(await bothRefuse(cwd, path)).toBe(
          `path does not resolve: ${cwd}/${path} (\`..\` below a missing directory)`,
        );
      }
    });

    it("`./x` diffs like `x`, and the repository root is refused by both", async () => {
      const cwd = fixtureDiff();
      const { rust } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "./a.txt", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("./a.txt")}&staged=false`,
      });
      expect(rust.hunks).toHaveLength(1);
      for (const path of [".", "./"]) {
        expect(await bothRefuse(cwd, path)).toBe("path must not be the repository root");
      }
    });

    it("a deleted file whose folder is now a regular file still diffs identically", async () => {
      const cwd = mkTempRepo("gw-parity-diff-notdir-");
      commitFile(cwd, "secret/x", "gone\n", "init", 0);
      rmSync(join(cwd, "secret"), { recursive: true });
      writeFileSync(join(cwd, "secret"), "now a file\n");
      const { rust } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "secret/x", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("secret/x")}&staged=false`,
      });
      expect(rust.hunks).toHaveLength(1);

      // A symlink to a file in that position is not a regular file: refused.
      symlinkSync(join(cwd, "secret"), join(cwd, "inlink"));
      expect(await bothRefuse(cwd, "inlink/x")).toMatch(
        /^path does not resolve: .* \(dangling, looping or unreadable component\)$/,
      );
    });

    // The cwd as the caller spells it may differ from the on-disk name (letter
    // case, or NFC vs NFD on macOS). Both sides must canonicalize it the same
    // way as the paths below it, or every in-repo path looks like an escape.
    describe("a cwd spelled differently from the disk", () => {
      /** Rename the repo dir to `onDisk`, return the cwd spelled `given`. */
      function respell(cwd, onDisk, given) {
        const disk = join(dirname(cwd), onDisk);
        renameSync(cwd, disk);
        return join(dirname(cwd), given);
      }

      for (const [label, onDisk, given] of [
        ["letter case", "Repo-case", "REPO-CASE"],
        ["NFC vs NFD", "d\u0065\u0301p-norm", "d\u00e9p-norm"],
      ]) {
        it(`${label}: in-repo paths are accepted, escapes still refused`, async (ctx) => {
          const base = mkTempRepo("gw-parity-diff-spelling-");
          commitFile(base, "a.txt", "a\n", "init", 0);
          writeFileSync(join(base, "a.txt"), "A\n");
          const cwd = respell(base, `${basename(base)}-${onDisk}`, `${basename(base)}-${given}`);
          // Only meaningful on a filesystem that folds the two spellings.
          if (!existsSync(join(cwd, "a.txt"))) return ctx.skip();
          const { rust, node } = await assertParity(dev, {
            command: "git-diff",
            args: { cwd, path: "a.txt", staged: false },
            httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=a.txt&staged=false`,
          });
          expect(rust.hunks).toHaveLength(1);
          expect(node.hunks).toHaveLength(1);
          const outside = join(dirname(cwd), `${basename(base)}-outside.txt`);
          writeFileSync(outside, `${SECRET}\n`);
          try {
            expect(await bothRefuse(cwd, `../${basename(outside)}`)).toMatch(/^path escapes cwd/);
          } finally {
            rmSync(outside, { force: true });
          }
        });
      }
    });

    it("a deleted file whose directory is gone still diffs identically", async () => {
      const cwd = mkTempRepo("gw-parity-diff-deleted-");
      commitFile(cwd, "old/deep/gone.txt", "bye\n", "init", 0);
      rmSync(join(cwd, "old"), { recursive: true });
      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "old/deep/gone.txt", staged: false },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("old/deep/gone.txt")}&staged=false`,
      });
      for (const side of [rust, node]) {
        expect(side.hunks).toHaveLength(1);
        expect(side.hunks[0].lines.every((l) => l.type === "delete")).toBe(true);
      }
    });
  });

  // A removed SQL comment `-- old` is the diff line `--- old`, an added `++x`
  // is `+++x`. Both parsers used to drop them as `---`/`+++` file headers,
  // returning the hunk with only its context lines.
  describe("hunk lines whose content starts with -- or ++", () => {
    const BEFORE = "SELECT 1;\n-- old comment\nSELECT 2;\n--- x\nSELECT 3;\n";
    const AFTER = "SELECT 1;\n++x\nSELECT 2;\n+++ y\nSELECT 3;\n";
    const EXPECTED = [
      ["context", "SELECT 1;"],
      ["delete", "-- old comment"],
      ["add", "++x"],
      ["context", "SELECT 2;"],
      ["delete", "--- x"],
      ["add", "+++ y"],
      ["context", "SELECT 3;"],
    ];

    for (const staged of [false, true]) {
      it(`are kept identically (${staged ? "staged" : "unstaged"})`, async () => {
        const cwd = mkTempRepo("gw-parity-diff-dashdash-");
        commitFile(cwd, "q.sql", BEFORE, "init", 0);
        writeFileSync(join(cwd, "q.sql"), AFTER);
        if (staged) runGit(cwd, ["add", "q.sql"]);
        const { rust, node } = await assertParity(dev, {
          command: "git-diff",
          args: { cwd, path: "q.sql", staged },
          httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=q.sql&staged=${staged}`,
        });
        for (const side of [rust, node]) {
          expect(side.hunks).toHaveLength(1);
          expect(side.hunks[0].lines.map((l) => [l.type, l.content])).toEqual(EXPECTED);
          expect(side.hunks[0].lines.at(-1)).toMatchObject({ oldLineNo: 5, newLineNo: 5 });
        }
      });
    }
  });
});

// With `diff.suppressBlankEmpty=true` git prints a blank context line as ""
// instead of " ". Rust and the dev-server used to drop it without consuming
// a line of the hunk (the TS frontend parser kept it), so the two sides
// disagreed and every later line number shifted.
describe("parity: git-diff with diff.suppressBlankEmpty", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  for (const staged of [false, true]) {
    it(`counts the "" blank context line (${staged ? "staged" : "unstaged"})`, async () => {
      const cwd = mkTempRepo("gw-parity-diff-blank-");
      runGit(cwd, ["config", "diff.suppressBlankEmpty", "true"]);
      commitFile(cwd, "f.txt", "a\n\nb\n", "init", 0);
      writeFileSync(join(cwd, "f.txt"), "a\n\nB\n");
      if (staged) runGit(cwd, ["add", "f.txt"]);
      const raw = execFileSync("git", ["-C", cwd, "diff", ...(staged ? ["--cached"] : []), "--", "f.txt"], {
        encoding: "utf-8",
      });
      expect(raw).toContain("\n a\n\n-b\n"); // git really printed ""

      const { rust, node } = await assertParity(dev, {
        command: "git-diff",
        args: { cwd, path: "f.txt", staged },
        httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=f.txt&staged=${staged}`,
      });
      for (const side of [rust, node]) {
        expect(side.hunks[0].lines.map((l) => [l.type, l.content, l.oldLineNo, l.newLineNo])).toEqual([
          ["context", "a", 1, 1],
          ["context", "", 2, 2],
          ["delete", "b", 3, null],
          ["add", "B", null, 3],
        ]);
      }
    });
  }
});

function runGit(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args]);
}
