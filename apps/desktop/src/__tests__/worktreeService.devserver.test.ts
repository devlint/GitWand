/**
 * v3.13 — The dev-server mirror of the Rust worktree service
 * (`src-tauri/src/worktree/`) must follow the same rules, or manual QA in
 * `dev:web` tests something other than what ships. Real git repos.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  devSlugify,
  devCreateWorktree,
  devExpandHook,
  devWorktreeUrl,
  devResolveBase,
  devFindRecord,
  devCommonDir,
  devWorktreeGuard,
  devRemovePrepare,
  devRemoveWorktree,
  devRestoreAsWorktree,
  // @ts-expect-error — plain ESM module without types, shared with dev-server.mjs
} from "../../dev-worktree-service.mjs";
// @ts-expect-error — plain ESM module without types
import { devHooksHash, devHooksFromRcText } from "../../dev-worktree-trust.mjs";

const sandboxes: string[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) rmSync(s, { recursive: true, force: true });
});

function repo(): { sandbox: string; path: string } {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gw-wt-svc-")));
  sandboxes.push(sandbox);
  const path = join(sandbox, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: path, encoding: "utf-8" }).trim();
  g("config", "user.name", "T");
  g("config", "user.email", "t@e.x");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(path, "README.md"), "hi\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { sandbox, path };
}

// Real git repos: several spawns per test, slow under a parallel monorepo run.
describe("dev-server worktree service", { timeout: 30_000 }, () => {
  it("slugifies like the backend", () => {
    expect(devSlugify("Fix Login!")).toBe("fix-login");
    expect(devSlugify("--a--b--")).toBe("a-b");
    expect(devSlugify("ÉtÉ")).toBe("t");
    expect(devSlugify("!!!")).toBeNull();
    expect(devSlugify("a".repeat(80))).toHaveLength(63);
  });

  it("uses the local HEAD without a remote", () => {
    const { path } = repo();
    const b = devResolveBase(path);
    expect(b.base_ref).toBe("main");
    expect(b.fallback_reason).toBe("no-remote");
  });

  it("creates in the default dir on task/<slug>, without upstream, and records it", () => {
    const { sandbox, path } = repo();
    const c = devCreateWorktree(path, { name: "Fix Login", kind: "manual" });
    expect(c.path).toBe(join(sandbox, "repo.worktrees", "fix-login"));
    expect(c.branch).toBe("task/fix-login");
    expect(existsSync(join(c.path, "README.md"))).toBe(true);
    const config = execFileSync("git", ["config", "--list"], { cwd: path, encoding: "utf-8" });
    expect(config).not.toContain("branch.task/fix-login.merge");
    expect(devFindRecord(devCommonDir(path), c.path)?.kind).toBe("manual");
    const again = devCreateWorktree(path, { name: "fix-login", kind: "manual" });
    expect(again.branch).toBe("task/fix-login-2");
  });

  it("keeps {name} unique on a collision at the length cap", () => {
    const { path } = repo();
    const a = devCreateWorktree(path, { name: "a".repeat(80), kind: "manual" });
    const b = devCreateWorktree(path, { name: "a".repeat(80), kind: "manual" });
    expect(b.name).not.toBe(a.name);
    expect(b.name.length).toBeLessThanOrEqual(63);
    expect(b.branch).toBe(`task/${b.name}`);
  });

  it("quotes hostile placeholder values through a real shell", () => {
    const hostile = "/tmp/a b/it's $(x);y \"q\"";
    const cmd = devExpandHook("printf %s {path}", { name: "n", path: hostile, branch: "", base: "", repoRoot: "" });
    expect(execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf-8" })).toBe(hostile);
  });

  it("runs url only for the trusted hash", () => {
    const { sandbox, path } = repo();
    const rc = `{"worktree":{"url":"printf '\\\\n  http://x/{name} \\\\n'"}}`;
    writeFileSync(join(path, ".gitwandrc"), rc);
    const c = devCreateWorktree(path, { name: "u", kind: "task" });
    const hash = devHooksHash(devHooksFromRcText(rc));
    const storePath = join(sandbox, "trust.json");
    expect(() => devWorktreeUrl(path, c.path, hash, { storePath, shell: "/bin/sh" })).toThrow(/not trusted/);
    writeFileSync(storePath, JSON.stringify({ [realpathSync(path)]: hash }));
    expect(devWorktreeUrl(path, c.path, hash, { storePath, shell: "/bin/sh" })).toBe("http://x/u");
  });

  it("guards like the backend: locked, keep file, other tool's directory", () => {
    const { sandbox, path } = repo();
    const add = (rel: string, b: string) => {
      const p = join(sandbox, rel);
      execFileSync("git", ["worktree", "add", "-q", "-b", b, p], { cwd: path });
      return realpathSync(p);
    };
    const locked = add("wt/l", "l");
    execFileSync("git", ["worktree", "lock", "--reason", "busy", locked], { cwd: path });
    expect(devWorktreeGuard(path, locked)).toMatchObject({ untouchable: true, reasons: ["locked"], lock_reason: "busy" });
    const kept = add("wt/k", "k");
    writeFileSync(join(kept, ".worktree-keep"), "");
    expect(devWorktreeGuard(path, kept).reasons).toEqual(["keep-file"]);
    const claude = add("x/.claude/worktrees/c", "c");
    expect(devWorktreeGuard(path, claude)).toMatchObject({ reasons: ["other-tool"], owned: false });
    expect(() => devWorktreeGuard(path, path)).toThrow(/Not a linked worktree/);
  });

  it("removes with the teardown gate, a snapshot-backed --force, and the merged task branch", async () => {
    const { path } = repo();
    writeFileSync(join(path, ".gitwandrc"), `{"worktree":{"teardown":"exit 1"}}`);
    const c = devCreateWorktree(path, { name: "rm", kind: "task" });
    writeFileSync(join(c.path, "README.md"), "changed\n");
    expect(devWorktreeGuard(path, c.path).teardown_required).toBe(true);
    expect(() => devRemoveWorktree(path, c.path, { teardownCode: 1 })).toThrow(/^teardown:/);
    // Dirty, no snapshot: no --force, git refuses.
    expect(() => devRemoveWorktree(path, c.path, { teardownSkipped: true })).toThrow(/git worktree remove failed/);
    const snaps: unknown[] = [];
    const createSnapshot = (...a: unknown[]) => {
      snaps.push(a);
      const id = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf-8" }).trim();
      execFileSync("git", ["update-ref", "refs/gitwand/snapshots/1-abc", id], { cwd: path });
      return { id: "1-abc" };
    };
    const prepared = await devRemovePrepare(path, c.path, { createSnapshot });
    expect(prepared.snapshot.id).toBe("1-abc");
    expect((snaps[0] as unknown[])[3]).toMatchObject({ name: "rm", branch: "task/rm" });
    const out = devRemoveWorktree(path, c.path, { snapshotId: "1-abc", teardownCode: 0 });
    expect(out.branch_deleted).toBe("task/rm");
    expect(existsSync(c.path)).toBe(false);
    expect(devFindRecord(devCommonDir(path), c.path)).toBeNull();
  });

  it("asks before removing a worktree GitWand did not create", () => {
    const { sandbox, path } = repo();
    const p = join(sandbox, "plain");
    execFileSync("git", ["worktree", "add", "-q", "-b", "plain", p], { cwd: path });
    expect(() => devRemoveWorktree(path, p, {})).toThrow(/^not-owned:/);
    devRemoveWorktree(path, p, { confirmNotOwned: true });
    expect(existsSync(p)).toBe(false);
  });

  it("restores a removal snapshot as a new worktree like the backend", () => {
    const { path } = repo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf-8" }).trim();
    const snap = {
      id: "1-abc",
      kind: "removal",
      headSha: head,
      worktree: { path: "/gone/fix", branch: "task/fix", name: "fix" },
      worktreeBase: { baseRef: "main", baseCommit: head },
    };
    const applied: string[] = [];
    const prims = {
      listSnapshots: () => [snap, { ...snap, id: "2-def", kind: "manual" }],
      applySnapshotState: (cwd: string) => {
        applied.push(cwd);
        writeFileSync(join(cwd, "restored.txt"), "back\n");
      },
    };
    const a = devRestoreAsWorktree(path, "1-abc", null, prims);
    expect(a.branch).toBe("restore/fix");
    expect(a.path.endsWith("fix-restored")).toBe(true);
    expect(applied).toEqual([a.path]);
    expect(existsSync(join(a.path, "restored.txt"))).toBe(true);
    expect(devFindRecord(devCommonDir(path), a.path)).toMatchObject({ kind: "task", base_ref: "main", base_commit: head });
    expect(devRestoreAsWorktree(path, "1-abc", null, prims).branch).toBe("restore/fix-2");
    expect(() => devRestoreAsWorktree(path, "2-def", null, prims)).toThrow(/not taken from a worktree/);
    const failing = { ...prims, applySnapshotState: () => { throw new Error("boom"); } };
    expect(() => devRestoreAsWorktree(path, "1-abc", "x", failing)).toThrow(/could not be restored/);
    expect(execFileSync("git", ["branch", "--list", "restore/x"], { cwd: path, encoding: "utf-8" }).trim()).toBe("");
  });
});
