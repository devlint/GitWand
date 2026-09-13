/**
 * v3.11.0 — splicing a hunk back into a real file, against real git output.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * `useDiffEdit.test.ts` covers the algebra against hand-built hunks, which is
 * where the boundary cases live. What it cannot prove is that the hunks GIT
 * actually produces line up with the assumptions those fixtures encode:
 * whether `newStart` is 1-based the way we read it, what `newCount` counts,
 * how a hunk at the very top or bottom of a file is reported, and what the
 * trailing "\\ No newline at end of file" marker does to the line list.
 *
 * So this drives the real `git diff` through the dev-server's own parser, the
 * same one the app consumes, and asserts the single strongest property:
 * splicing a hunk's own post-image back in is a byte-for-byte no-op. If the
 * range is off by one, or an EOL is rewritten, or a trailing newline is
 * invented or dropped, the file changes and this fails.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { mkTempRepo, commitFile } from "./fixtures.mjs";
import { hunkPostImage, spliceHunk } from "../../src/composables/useDiffEdit.ts";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });

/** The app's own diff for `path`, straight from the dev-server. */
async function diffOf(dev, cwd, path) {
  const res = await dev.fetch(
    `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=false`,
  );
  expect(res.ok, `git-diff failed for ${path}`).toBe(true);
  return res.json();
}

/**
 * Build a repo where `name` is committed as `before` then edited to `after`,
 * and return the parsed diff plus the file's current bytes.
 */
async function scenario(dev, name, before, after) {
  const cwd = mkTempRepo("gw-diff-edit-");
  commitFile(cwd, name, before, `add ${name}`, 0);
  writeFileSync(join(cwd, name), after);
  const diff = await diffOf(dev, cwd, name);
  return { cwd, diff, onDisk: readFileSync(join(cwd, name), "utf-8") };
}

describe("splicing a real git hunk", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  const cases = [
    {
      name: "an edit in the middle of a file",
      file: "mid.txt",
      before: "one\ntwo\nthree\nfour\nfive\n",
      after: "one\ntwo\nTHREE\nfour\nfive\n",
    },
    {
      name: "an edit on the first line",
      file: "first.txt",
      before: "one\ntwo\nthree\n",
      after: "ONE\ntwo\nthree\n",
    },
    {
      name: "an edit on the last line",
      file: "last.txt",
      before: "one\ntwo\nthree\n",
      after: "one\ntwo\nTHREE\n",
    },
    {
      name: "added lines",
      file: "grown.txt",
      before: "one\ntwo\n",
      after: "one\ninserted\nalso-inserted\ntwo\n",
    },
    {
      name: "removed lines",
      file: "shrunk.txt",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nfour\n",
    },
    {
      name: "a file with CRLF endings",
      file: "crlf.txt",
      before: "one\r\ntwo\r\nthree\r\n",
      after: "one\r\nTWO\r\nthree\r\n",
    },
    {
      name: "a file with no trailing newline",
      file: "notrailing.txt",
      before: "one\ntwo\nthree",
      after: "one\nTWO\nthree",
    },
    {
      name: "a blank line in the edited region",
      file: "blank.txt",
      before: "one\n\ntwo\n",
      after: "one\n\nTWO\n",
    },
  ];

  it.each(cases)("$name: splicing the post-image back is a no-op", async ({ file, before, after }) => {
    const { diff, onDisk } = await scenario(dev, file, before, after);
    expect(diff.hunks.length, "git produced at least one hunk").toBeGreaterThan(0);

    let text = onDisk;
    for (const hunk of diff.hunks) {
      const result = spliceHunk(text, hunk, hunkPostImage(hunk));
      expect(result.ok, `hunk ${hunk.header} was refused as stale`).toBe(true);
      text = result.text;
    }

    expect(text, "the file must be byte-identical after a no-op splice").toBe(onDisk);
  }, 30_000);

  it("an actual edit lands on the right lines and nowhere else", async () => {
    const { cwd, diff, onDisk } = await scenario(
      dev,
      "edit.txt",
      "alpha\nbravo\ncharlie\ndelta\necho\n",
      "alpha\nbravo\nCHARLIE\ndelta\necho\n",
    );

    const hunk = diff.hunks[0];
    const edited = spliceHunk(text(onDisk), hunk, hunkPostImage(hunk).replace("CHARLIE", "EDITED"));
    expect(edited.ok).toBe(true);

    writeFileSync(join(cwd, "edit.txt"), edited.text);
    const lines = readFileSync(join(cwd, "edit.txt"), "utf-8").split("\n");
    expect(lines[2]).toBe("EDITED");
    // Everything outside the edited line is untouched.
    expect(lines[0]).toBe("alpha");
    expect(lines[1]).toBe("bravo");
    expect(lines[3]).toBe("delta");
    expect(lines[4]).toBe("echo");

    // And git agrees it is a one-line change, not a whole-file rewrite.
    const stat = git(cwd, ["diff", "--numstat", "--", "edit.txt"]).trim();
    expect(stat, `unexpected churn: ${stat}`).toMatch(/^1\t1\t/);
  }, 30_000);
});

/** Identity helper, kept so the intent of the call above reads clearly. */
function text(s) {
  return s;
}
