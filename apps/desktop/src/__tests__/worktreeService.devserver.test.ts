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

describe("dev-server worktree service", () => {
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
});
