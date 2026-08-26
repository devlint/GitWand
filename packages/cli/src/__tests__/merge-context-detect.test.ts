/**
 * accuracy lot C — detectMergeContext : détection de l'opération git en cours depuis
 * l'état du répertoire .git, sur de vrais dépôts temporaires (jamais de mock
 * de la couche git, conformément aux contraintes du repo).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectMergeContext } from "../git.js";

// Environnement git HERMÉTIQUE : sans ça, la config globale/système de la
// machine hôte s'invite dans le dépôt temporaire — un core.hooksPath global
// (husky…), une signature GPG qui attend une passphrase ou un éditeur
// configuré suffisent à faire pendre `git rebase` jusqu'au timeout du test.
const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: HERMETIC_GIT_ENV,
    // Un git qui attend une entrée doit échouer vite et fort, pas pendre
    // silencieusement jusqu'au timeout de vitest.
    timeout: 10_000,
  });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.hooksPath", "/dev/null"]);
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

// Tests d'intégration git : des dizaines de spawns par test, et macOS taxe
// chaque exec (XProtect) — 5 s de timeout vitest ne suffisent pas sur un vrai
// Mac alors que la suite passe en <1 s sur Linux. Budget explicite, distinct du
// timeout dur de 10 s par appel git qui attrape les vrais blocages.
const IT_TIMEOUT = { timeout: 30_000 };

describe("detectMergeContext", () => {
  it("returns null on a clean repo", IT_TIMEOUT, () => {
    initRepo(repo);
    commitFile(repo, "a.txt", "x\n", "init");
    expect(detectMergeContext(repo)).toBeNull();
  });

  it("returns null outside a git repo", IT_TIMEOUT, () => {
    expect(detectMergeContext(repo)).toBeNull();
  });

  it("detects a merge in progress, ours = the checked-out target", IT_TIMEOUT, () => {
    makeDivergence(repo);
    try { git(repo, ["merge", "feature"]); } catch { /* conflit attendu */ }
    const ctx = detectMergeContext(repo);
    expect(ctx?.operation).toBe("merge");
    expect(ctx?.targetSide).toBe("ours");
    expect(ctx?.oursRef).toBe("main");
    expect(ctx?.theirsRef).toContain("feature");
  });

  it("detects a rebase in progress, ours = the branch rebased onto", IT_TIMEOUT, () => {
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

  it("detects a cherry-pick in progress", IT_TIMEOUT, () => {
    makeDivergence(repo);
    const sha = git(repo, ["rev-parse", "feature"]).trim();
    try { git(repo, ["cherry-pick", sha]); } catch { /* conflit attendu */ }
    const ctx = detectMergeContext(repo);
    expect(ctx?.operation).toBe("cherry-pick");
    expect(ctx?.targetSide).toBe("ours");
    expect(ctx?.oursRef).toBe("main");
  });

  it("works from a linked worktree (.git is a file)", IT_TIMEOUT, () => {
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
