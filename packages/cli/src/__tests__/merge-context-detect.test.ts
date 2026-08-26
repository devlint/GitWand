/**
 * v3.10 — detectMergeContext : détection de l'opération git en cours depuis
 * l'état du répertoire .git, sur de vrais dépôts temporaires (jamais de mock
 * de la couche git, conformément aux contraintes du repo).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectMergeContext } from "../git.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

function commitFile(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", msg]);
}

/** main et feature modifient la même ligne → toute intégration conflicte. */
function makeDivergence(cwd: string): void {
  initRepo(cwd);
  commitFile(cwd, "a.txt", "base\n", "base");
  git(cwd, ["checkout", "-b", "feature"]);
  commitFile(cwd, "a.txt", "feature\n", "feature change");
  git(cwd, ["checkout", "main"]);
  commitFile(cwd, "a.txt", "main\n", "main change");
}

let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "gw-ctx-")); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("detectMergeContext", () => {
  it("returns null on a clean repo", () => {
    initRepo(repo);
    commitFile(repo, "a.txt", "x\n", "init");
    expect(detectMergeContext(repo)).toBeNull();
  });

  it("returns null outside a git repo", () => {
    expect(detectMergeContext(repo)).toBeNull();
  });

  it("detects a merge in progress, ours = the checked-out target", () => {
    makeDivergence(repo);
    try { git(repo, ["merge", "feature"]); } catch { /* conflit attendu */ }
    const ctx = detectMergeContext(repo);
    expect(ctx?.operation).toBe("merge");
    expect(ctx?.targetSide).toBe("ours");
    expect(ctx?.oursRef).toBe("main");
    expect(ctx?.theirsRef).toContain("feature");
  });

  it("detects a rebase in progress, ours = the branch rebased onto", () => {
    makeDivergence(repo);
    git(repo, ["checkout", "feature"]);
    try { git(repo, ["rebase", "main"]); } catch { /* conflit attendu */ }
    const ctx = detectMergeContext(repo);
    expect(ctx?.operation).toBe("rebase");
    // L'inversion célèbre : pendant un rebase, « ours » est la branche CIBLE
    // (main), pas le travail de l'utilisateur. targetSide la déclare.
    expect(ctx?.targetSide).toBe("ours");
    expect(ctx?.theirsRef).toContain("feature");
  });

  it("detects a cherry-pick in progress", () => {
    makeDivergence(repo);
    const sha = git(repo, ["rev-parse", "feature"]).trim();
    try { git(repo, ["cherry-pick", sha]); } catch { /* conflit attendu */ }
    const ctx = detectMergeContext(repo);
    expect(ctx?.operation).toBe("cherry-pick");
    expect(ctx?.targetSide).toBe("ours");
    expect(ctx?.oursRef).toBe("main");
  });

  it("works from a linked worktree (.git is a file)", () => {
    makeDivergence(repo);
    const wt = join(repo, "..", "gw-ctx-wt-" + Date.now());
    git(repo, ["worktree", "add", wt, "feature"]);
    try {
      try { git(wt, ["merge", "main"]); } catch { /* conflit attendu */ }
      const ctx = detectMergeContext(wt);
      expect(ctx?.operation).toBe("merge");
      expect(ctx?.oursRef).toBe("feature");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
