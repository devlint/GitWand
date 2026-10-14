// @vitest-environment jsdom
//
// `useGitRepo` reaches `../../utils/backend`, which reads `window` at import
// time (apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * #266 — the Git Tree log follows ref moves that keep the top commit.
 *
 * The IPC wrapper module is mocked, but `getGitLog` / `getGitRevCount` run the
 * same `git log` / `git rev-list` the dev-server routes run, against a real
 * temporary repository (AGENTS.md: never a mocked git layer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../utils/backend");

import { useGitRepo } from "../useGitRepo";
import { getGitLog, getGitRevCount, type GitLogEntry } from "../../utils/backend";

const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "GitWand Test",
    GIT_AUTHOR_EMAIL: "test@gitwand.test",
    GIT_COMMITTER_NAME: "GitWand Test",
    GIT_COMMITTER_EMAIL: "test@gitwand.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8", input });
}

/** Same format and parsing as dev-server.mjs `/api/git-log`. */
function realGitLog(cwd: string, count = 100, all = true, offset = 0): GitLogEntry[] {
  const format = "%h%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e";
  const args = ["log"];
  if (all) args.push("--all");
  if (offset > 0) args.push(`--skip=${offset}`);
  args.push(`-n${count}`, `--format=${format}`);
  const out = git(cwd, args);
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const f = r.split("\x1f");
      return {
        hash: f[0],
        hashFull: f[1],
        author: f[2],
        email: f[3],
        date: f[4],
        message: f[5],
        body: f[6].trim(),
        parents: f[7].trim().split(/\s+/).filter(Boolean),
        refs: f[8].trim(),
      };
    });
}

/** A repo with `n` linear empty commits on main (c1 … cn, increasing dates). */
function makeRepo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-log-refs-"));
  git(dir, ["init", "-q", "-b", "main"]);
  let stream = "";
  for (let i = 1; i <= n; i++) {
    const msg = `c${i}`;
    stream +=
      `commit refs/heads/main\nmark :${i}\n` +
      `committer GitWand Test <test@gitwand.test> ${1_700_000_000 + i * 60} +0000\n` +
      `data ${msg.length}\n${msg}\n` +
      (i > 1 ? `from :${i - 1}\n` : "") +
      "\n";
  }
  git(dir, ["fast-import", "--quiet"], stream);
  git(dir, ["reset", "-q", "--hard", "main"]);
  return dir;
}

/** Full hash of the commit whose subject is `subject`. */
function sha(cwd: string, subject: string): string {
  return git(cwd, ["log", "--all", "--format=%H", `--grep=^${subject}$`]).trim();
}

/** Add a commit on top of `parent` and point `ref` at it (no checkout). */
function commitOn(cwd: string, parent: string, ref: string, subject: string): string {
  const tree = git(cwd, ["rev-parse", `${parent}^{tree}`]).trim();
  const c = git(cwd, ["commit-tree", tree, "-p", parent, "-m", subject]).trim();
  git(cwd, ["update-ref", ref, c]);
  return c;
}

const repos: string[] = [];
function newRepo(n: number) {
  const dir = makeRepo(n);
  repos.push(dir);
  return dir;
}

/** Optional one-shot gate on the next paged (`offset > 0`) git log call. */
let pageGate: Promise<void> | null = null;

beforeEach(() => {
  pageGate = null;
  vi.mocked(getGitLog).mockImplementation(async (cwd, count, all, _author, offset) => {
    // git runs now — against the repo as it is at call time — like the real
    // backend; only the result's delivery can be held back.
    const result = realGitLog(cwd, count ?? 100, all ?? true, offset ?? 0);
    if ((offset ?? 0) > 0 && pageGate) {
      const gate = pageGate;
      pageGate = null;
      await gate;
    }
    return result;
  });
  vi.mocked(getGitRevCount).mockImplementation(async (cwd) =>
    Number(git(cwd, ["rev-list", "--count", "--all"]).trim()),
  );
});

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(repo: ReturnType<typeof useGitRepo>, dir: string) {
  repo.folderPath.value = dir;
  await nextTick(); // let the folderPath watcher reset the log first
}

function refsOf(repo: ReturnType<typeof useGitRepo>, hash: string): string | undefined {
  return repo.log.value.find((e) => e.hashFull === hash)?.refs;
}

describe("loadLog follows ref moves that keep the top commit (#266)", () => {
  it(
    "picks up main reset onto an older commit while another branch keeps the top",
    async () => {
      const dir = newRepo(5);
      git(dir, ["branch", "feature"]);
      const repo = useGitRepo();
      await open(repo, dir);
      await repo.loadLog();
      const top = sha(dir, "c5");
      const c3 = sha(dir, "c3");
      expect(repo.log.value[0].hashFull).toBe(top);
      expect(refsOf(repo, top)).toBe("HEAD -> main, feature");

      git(dir, ["reset", "-q", "--hard", c3]);
      await repo.loadLog(); // not forced — the terminal-mutation path

      expect(repo.log.value[0].hashFull).toBe(top); // top commit unchanged
      expect(refsOf(repo, top)).toBe("feature");
      expect(refsOf(repo, c3)).toBe("HEAD -> main");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "picks up a new branch created on an existing commit",
    async () => {
      const dir = newRepo(5);
      const repo = useGitRepo();
      await open(repo, dir);
      await repo.loadLog();
      const c2 = sha(dir, "c2");
      expect(refsOf(repo, c2)).toBe("");

      git(dir, ["branch", "topic", c2]);
      await repo.loadLog();

      expect(refsOf(repo, c2)).toBe("topic");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the held log untouched when nothing moved",
    async () => {
      const dir = newRepo(5);
      const repo = useGitRepo();
      await open(repo, dir);
      await repo.loadLog();
      const held = repo.log.value;

      await repo.loadLog();

      expect(repo.log.value).toBe(held);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "does not restore the session cache with stale refs after a ref move",
    async () => {
      const a = newRepo(5);
      const b = newRepo(3);
      git(a, ["branch", "feature"]);
      const repo = useGitRepo();

      // Fully paged on open → cached for `a`.
      await open(repo, a);
      await repo.loadLog();
      expect(repo.logHasMore.value).toBe(false);

      // Switch away, move main in `a` behind the app's back, switch back.
      await open(repo, b);
      await repo.loadLog();
      const c3 = sha(a, "c3");
      git(a, ["reset", "-q", "--hard", c3]);
      await open(repo, a);
      await repo.loadLog();

      expect(refsOf(repo, sha(a, "c5"))).toBe("feature");
      expect(refsOf(repo, c3)).toBe("HEAD -> main");

      // And the refreshed log is what the next switch-back restores.
      await open(repo, b);
      await repo.loadLog();
      await open(repo, a);
      await repo.loadLog();
      expect(refsOf(repo, c3)).toBe("HEAD -> main");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "drops an in-flight page fetched against a log that loadLog replaced",
    async () => {
      const dir = newRepo(130);
      const repo = useGitRepo();
      await open(repo, dir);
      await repo.loadLog();
      expect(repo.log.value).toHaveLength(100);
      expect(repo.logHasMore.value).toBe(true);

      // A scroll page goes out at --skip=100 and is held in flight.
      let release!: () => void;
      pageGate = new Promise<void>((r) => (release = r));
      const page = repo.loadMoreLog();

      // Meanwhile a commit lands on top and loadLog takes the fresh page.
      commitOn(dir, sha(dir, "c130"), "refs/heads/topic", "c131");
      await repo.loadLog();
      expect(repo.log.value[0].message).toBe("c131");

      release();
      await page;

      // No gap: the held rows are exactly git's first rows.
      const truth = realGitLog(dir, 1000).map((e) => e.hashFull);
      expect(repo.log.value.map((e) => e.hashFull)).toEqual(truth.slice(0, repo.log.value.length));

      // The background prefetch then completes the log — still gapless.
      await vi.waitFor(() => expect(repo.logHasMore.value).toBe(false), { timeout: 10_000 });
      expect(repo.log.value.map((e) => e.hashFull)).toEqual(truth);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
