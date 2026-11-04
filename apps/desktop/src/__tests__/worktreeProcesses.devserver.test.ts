/**
 * v3.13 — the dev-server mirror of `worktree_stop_processes`: same refusal
 * rule and the same "list, don't kill" rule for processes it did not start.
 * Real repo, real processes (needs `ps`, and `lsof` on macOS).
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain ESM module without types, shared with dev-server.mjs
import { devStopProcessesIn } from "../../dev-worktree-processes.mjs";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gitwand-devwtproc-")));
const main = join(root, "main");
const linked = join(root, "linked wt");
const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
execFileSync("git", ["init", "-q", "-b", "main", main]);
git("config", "user.name", "Test");
git("config", "user.email", "t@example.com");
git("config", "commit.gpgsign", "false");
git("commit", "-q", "--allow-empty", "-m", "init");
git("worktree", "add", "-q", "-b", "task", linked);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("dev-server worktree process stop", () => {
  it("refuses the main worktree and a non-worktree", async () => {
    await expect(devStopProcessesIn(main, main, true, new Map())).rejects.toThrow(/Not a linked worktree/);
    await expect(devStopProcessesIn(main, root, true, new Map())).rejects.toThrow(/Not a linked worktree/);
  });

  it("lists a reparented sleep in a linked worktree and kills it only when asked", async () => {
    const pid = Number(
      execFileSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { cwd: linked }).toString().trim(),
    );
    const left = await devStopProcessesIn(main, linked, false, new Map());
    expect(left.map((p: { pid: number }) => p.pid)).toContain(pid);
    expect(alive(pid)).toBe(true);
    expect(await devStopProcessesIn(main, linked, true, new Map())).toEqual([]);
    expect(alive(pid)).toBe(false);
  }, 15000);
});
