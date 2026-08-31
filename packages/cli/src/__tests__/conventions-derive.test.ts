/**
 * accuracy lot F — `deriveFromHistory` : le replay mesure réellement les
 * conventions d'une équipe sur de vrais dépôts temporaires (git hermétique,
 * jamais de mock de la couche git).
 *
 * Le dépôt fabriqué simule une équipe qui : régénère son package-lock.json
 * après chaque merge (le commit ne correspond jamais à la fusion sémantique),
 * reconstruit son CHANGELOG à l'outillage (ni union ni côté cible), et prend
 * toujours theirs sur les fichiers .snap.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveFromHistory, conventionsPath, supportsMergeTreeWriteTree } from "../commands/conventions.js";

// Le replay exige git >= 2.38 (merge-tree --write-tree) — sur un git plus
// ancien ces tests se skippent explicitement au lieu d'échouer en silence.
const MODERN_GIT = supportsMergeTreeWriteTree();

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
    cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    env: HERMETIC_GIT_ENV, timeout: 10_000,
  });
}

const LOCK = "package-lock.json";
const CHANGELOG = "CHANGELOG.md";
const SNAP = "ui.snap";

function writeAll(cwd: string, suffix: string): void {
  writeFileSync(join(cwd, LOCK), `{\n  "lockfileVersion": 3,\n  "shared": "${suffix}"\n}\n`);
  writeFileSync(join(cwd, CHANGELOG), `# Changelog\n\n- entry ${suffix}\n`);
  writeFileSync(join(cwd, SNAP), `snapshot ${suffix}\n`);
}

/** Fabrique `n` merges conflictuels résolus selon les conventions simulées. */
function buildHistory(cwd: string, n: number): void {
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.hooksPath", "/dev/null"]);
  writeAll(cwd, "base-0");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "base"]);

  for (let i = 0; i < n; i++) {
    git(cwd, ["checkout", "-b", `feature-${i}`]);
    writeAll(cwd, `feature-${i}`);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", `feature ${i}`]);

    git(cwd, ["checkout", "main"]);
    writeAll(cwd, `main-${i}`);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", `main ${i}`]);

    try { git(cwd, ["merge", `feature-${i}`]); } catch { /* conflit attendu */ }

    // Résolutions « humaines » simulées :
    // lockfile régénéré (≠ toute fusion), changelog reconstruit à l'outil,
    // .snap : theirs (le côté feature) tel quel.
    writeFileSync(join(cwd, LOCK), `{\n  "lockfileVersion": 3,\n  "shared": "regenerated-${i}"\n}\n`);
    writeFileSync(join(cwd, CHANGELOG), `# Changelog\n\n## v1.${i}.0\n\n- rebuilt by tooling\n`);
    writeFileSync(join(cwd, SNAP), `snapshot feature-${i}\n`);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", `merge feature-${i}`]);
  }
}

let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "gw-conv-")); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

// Tests d'intégration git : des dizaines de spawns par test, et macOS taxe
// chaque exec (XProtect) — 5 s de timeout vitest ne suffisent pas sur un vrai
// Mac alors que la suite passe en <1 s sur Linux. Budget explicite, distinct du
// timeout dur de 10 s par appel git qui attrape les vrais blocages.
const IT_TIMEOUT = { timeout: 30_000 };

describe.skipIf(!MODERN_GIT)("deriveFromHistory", () => {
  it("measures the simulated team's conventions from six real merges", IT_TIMEOUT, () => {
    buildHistory(repo, 6);
    const { conventions } = deriveFromHistory(repo, 200);

    expect(conventions.evidence.mergesReplayed).toBe(6);
    expect(conventions.generatedFiles?.verdict).toBe("regenerate");
    expect(conventions.generatedFiles?.samples).toBeGreaterThanOrEqual(5);
    expect(conventions.changelog?.verdict).toBe("tool-rebuilt");
    expect(conventions.pathPolicies).toEqual([
      expect.objectContaining({ glob: "**/*.snap", policy: "prefer-theirs" }),
    ]);
  });

  it("emits no verdict below the evidence floor (4 merges)", IT_TIMEOUT, () => {
    buildHistory(repo, 4);
    const { conventions } = deriveFromHistory(repo, 200);
    expect(conventions.generatedFiles).toBeUndefined();
    expect(conventions.changelog).toBeUndefined();
    expect(conventions.pathPolicies).toBeUndefined();
  });

  it("respects the merge cap", IT_TIMEOUT, () => {
    buildHistory(repo, 6);
    const { conventions } = deriveFromHistory(repo, 3);
    expect(conventions.evidence.mergesReplayed).toBe(3);
    expect(conventions.generatedFiles).toBeUndefined(); // 3 < plancher
  });

  it("conventionsPath resolves inside .git, worktree-safe", IT_TIMEOUT, () => {
    buildHistory(repo, 1);
    const p = conventionsPath(repo);
    expect(p).toContain(".git");
    expect(p.endsWith(join("gitwand", "conventions.json"))).toBe(true);
    expect(existsSync(join(repo, ".git"))).toBe(true);
  });
});
