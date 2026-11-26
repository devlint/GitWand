/**
 * Guided bisect — the dev-server mirror of `src-tauri/src/commands/bisect.rs`
 * must follow the same rules, or manual QA in `dev:web` tests something other
 * than what ships. Real git repos.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  devBisectRepoState,
  devBisectStatus,
  devBisectStart,
  devBisectMark,
  devBisectReset,
  parseSqQuoted,
  // @ts-expect-error — plain ESM module without types, shared with dev-server.mjs
} from "../../dev-bisect.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function linear(n: number) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "gw-bisect-")));
  dirs.push(path);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: path, encoding: "utf-8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.name", "T");
  g("config", "user.email", "t@e.x");
  g("config", "commit.gpgsign", "false");
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(path, "a.txt"), `v${i}\n`);
    g("add", "-A");
    g("commit", "-q", "-m", `c${i}`);
  }
  const sha = (s: string) => g("log", "--all", "--format=%H", `--grep=^${s}$`);
  return { path, g, sha };
}

describe("dev-server bisect", { timeout: 30_000 }, () => {
  it("runs a bisect to the culprit and back, like the backend", () => {
    const { path, g, sha } = linear(8);
    const [c1, c5, c8] = [sha("c1"), sha("c5"), sha("c8")];
    expect(devBisectRepoState(path)).toBeNull();

    let st = devBisectStart(path, c8, c1);
    expect(st.remaining).toBeGreaterThan(0);
    expect(st.bad).toBe(c8);
    expect(st.good).toEqual([c1]);
    expect(st.start).toBe("main");
    expect(st.terms).toEqual(["bad", "good"]);
    expect(devBisectRepoState(path)?.state).toBe("bisect");
    expect(() => devBisectStart(path, c8, c1)).toThrow();

    for (let i = 0; i < 10 && st.candidates.length !== 1; i++) {
      let bad = true;
      try {
        g("merge-base", "--is-ancestor", c5, "HEAD");
      } catch {
        bad = false;
      }
      st = devBisectMark(path, bad ? "bad" : "good");
    }
    expect(st.candidates).toEqual([c5]);

    devBisectReset(path);
    expect(devBisectRepoState(path)).toBeNull();
    expect(g("symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("refuses what the backend refuses", () => {
    const { path, sha } = linear(4);
    const [c1, c4] = [sha("c1"), sha("c4")];
    writeFileSync(join(path, "a.txt"), "dirty\n");
    expect(() => devBisectStart(path, c4, c1)).toThrow(/uncommitted/);
    expect(() => devBisectStart(path, c4, "--foo")).toThrow();
    expect(existsSync(join(path, ".git", "BISECT_LOG"))).toBe(false);
    expect(() => devBisectMark(path, "maybe")).toThrow();
  });

  it("lists the candidates when only skipped commits are left", () => {
    const { path, sha } = linear(4);
    const [c1, c2, c3, c4] = [sha("c1"), sha("c2"), sha("c3"), sha("c4")];
    let st = devBisectStart(path, c4, c1);
    for (let i = 0; i < 5 && st.candidates.length === 0; i++) st = devBisectMark(path, "skip");
    expect(st.candidates.length).toBeGreaterThan(1);
    for (const c of [c2, c3, c4]) expect(st.candidates).toContain(c);
  });

  it("orders the ends by ancestry, describes commits, counts without skips", () => {
    const { path, g, sha } = linear(8);
    const [c1, c8] = [sha("c1"), sha("c8")];
    let st = devBisectStart(path, c1, c8);
    expect(st.bad).toBe(c8);
    expect(st.good).toEqual([c1]);
    const range = Number(g("rev-list", "--count", c8, "--not", c1));
    expect(st.remaining).toBe(range - 1);
    const head = g("rev-parse", "HEAD");
    expect(st.commits.find((c: { hash: string }) => c.hash === head)?.subject).toBe(
      g("log", "-1", "--format=%s", head),
    );
    st = devBisectMark(path, "skip");
    expect(st.remaining).toBe(range - 2);
  });

  it("keeps a mark whose checkout fails, then moves on with next", () => {
    const { path, g, sha } = linear(8);
    const [c1, c8] = [sha("c1"), sha("c8")];
    devBisectStart(path, c8, c1);
    const tested = g("rev-parse", "HEAD");
    writeFileSync(join(path, "a.txt"), "local edit\n");
    expect(() => devBisectMark(path, "good")).toThrow();
    let st = devBisectStatus(path);
    expect(st.good).toContain(tested);
    expect(st.pendingCheckout).toBe(true);
    g("checkout", "--", "a.txt");
    st = devBisectMark(path, "next");
    expect(st.current).not.toBe(tested);
    expect(st.pendingCheckout).toBe(false);
  });

  it("reads a terminal bisect with custom terms", () => {
    const { path, g, sha } = linear(8);
    const [c1, c8] = [sha("c1"), sha("c8")];
    g("bisect", "start", "--term-new=broken", "--term-old=fixed", c8, c1);
    const st = devBisectStatus(path);
    expect(st.terms).toEqual(["broken", "fixed"]);
    expect(st.bad).toBe(c8);
    const head = g("rev-parse", "HEAD");
    devBisectMark(path, "good");
    expect(g("rev-parse", `refs/bisect/fixed-${head}`)).toBe(head);
  });
  it("counts only the skips still inside the range", () => {
    const { path, g, sha } = linear(8);
    const [c1, c8] = [sha("c1"), sha("c8")];
    devBisectStart(path, c8, c1);
    const skippedHash = g("rev-parse", "HEAD");
    let st = devBisectMark(path, "skip");
    let leftOut = false;
    for (let i = 0; i < 3 && st.candidates.length === 0; i++) {
      st = devBisectMark(path, "good");
      const range = g("rev-list", c8, "--not", ...st.good).split("\n").filter(Boolean);
      leftOut ||= !range.includes(skippedHash);
      expect(st.remaining).toBe(range.filter((h) => h !== c8 && !st.skipped.includes(h)).length);
    }
    expect(leftOut).toBe(true);
  });

  it("follows a pathspec bisect to its culprit", () => {
    const { path, g, sha } = linear(1);
    const commit = (file: string, content: string, subject: string) => {
      writeFileSync(join(path, file), content);
      g("add", "-A");
      g("commit", "-q", "-m", subject);
    };
    commit("b.txt", "1\n", "c2");
    for (let i = 3; i <= 8; i++) {
      if (i === 6) commit("b.txt", "2\n", "c6");
      else commit("a.txt", `v${i}\n`, `c${i}`);
    }
    g("bisect", "start", sha("c8"), sha("c2"), "--", "b.txt");
    let st = devBisectStatus(path);
    for (let i = 0; i < 5 && st.candidates.length === 0; i++) st = devBisectMark(path, "bad");
    expect(st.candidates).toEqual([sha("c6")]);
    expect(st.remaining).toBe(0);
  });

  it("follows a first-parent bisect", () => {
    const { path, g, sha } = linear(1);
    g("checkout", "-q", "-b", "side");
    for (const s of ["s1", "s2"]) {
      writeFileSync(join(path, "side.txt"), s);
      g("add", "-A");
      g("commit", "-q", "-m", s);
    }
    g("checkout", "-q", "main");
    writeFileSync(join(path, "a.txt"), "v2\n");
    g("add", "-A");
    g("commit", "-q", "-m", "c2");
    g("merge", "-q", "--no-ff", "-m", "m", "side");
    g("bisect", "start", "--first-parent", g("rev-parse", "HEAD"), sha("c1"));
    expect(devBisectStatus(path).remaining).toBe(1);
    expect(devBisectMark(path, "bad").candidates).toEqual([sha("c2")]);
  });

  it("reads the commit under test of a no-checkout bisect", () => {
    const { path, g, sha } = linear(8);
    g("bisect", "start", "--no-checkout", sha("c8"), sha("c1"));
    const tested = g("rev-parse", "BISECT_HEAD");
    expect(tested).not.toBe(g("rev-parse", "HEAD"));
    expect(devBisectStatus(path).current).toBe(tested);
  });

  it("reports an unknown commit as such", () => {
    const { path, sha } = linear(4);
    expect(() => devBisectStart(path, "0123456789abcdef0123456789abcdef01234567", sha("c1"))).toThrow(
      /^(?!.*separate branches)/,
    );
    expect(devBisectRepoState(path)).toBeNull();
  });

  it("unquotes BISECT_NAMES", () => {
    expect(parseSqQuoted("'--' 'a.txt' 'it'\\''s b.txt'\n")).toEqual(["--", "a.txt", "it's b.txt"]);
    expect(parseSqQuoted("\n")).toEqual([]);
  });
});
