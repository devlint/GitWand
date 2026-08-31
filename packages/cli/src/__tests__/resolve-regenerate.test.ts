/**
 * Fix round 1 (review Important #1/#3) — régression pour le trou de la
 * carte de siblings de la pass 2 (accuracy lot D).
 *
 * `RegenerationContext.siblingFiles` documente sa clé comme « chaque AUTRE
 * fichier de ce merge » (types.ts), pas « chaque autre fichier CONFLICTÉ ».
 * Le cas le plus courant — un lockfile seul en conflit, sa source de vérité
 * (`package.json`) ayant fusionné proprement sans le moindre marqueur — ne
 * fait JAMAIS apparaître `package.json` dans `getConflictedFiles()` /
 * `outcomes` de la pass 1. Ce test drive `cmdResolve` de bout en bout (pas
 * seulement `regenerate-runner.ts` en isolation) sur un vrai dépôt où
 * exactement ce scénario se produit, pour prouver que la pass 2 marque bien
 * la source "clean" et régénère malgré tout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdResolve } from "../commands/resolve.js";
import { isToolchainAvailable } from "../regenerate-runner.js";

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

const IT_TIMEOUT = { timeout: 30_000 };

describe.skipIf(!isToolchainAvailable("npm"))("cmdResolve --regenerate — clean sibling regression", () => {
  let repo: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "gw-resolve-regen-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  it(
    "regenerates package-lock.json when package.json merged cleanly (never conflicted, never in outcomes)",
    IT_TIMEOUT,
    async () => {
      initRepo(repo);
      const pkgJson = '{"name":"e2e","version":"1.0.0"}\n';
      writeFileSync(join(repo, "package.json"), pkgJson, "utf-8");
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
        env: HERMETIC_GIT_ENV,
      });
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);

      git(repo, ["checkout", "-b", "feature"]);
      bumpLockVersion(repo, "1.1.0");
      git(repo, ["commit", "-a", "-m", "feature: lock version bump"]);

      git(repo, ["checkout", "main"]);
      bumpLockVersion(repo, "1.0.0-main");
      git(repo, ["commit", "-a", "-m", "main: lock version tweak"]);

      try {
        git(repo, ["merge", "feature"]);
      } catch {
        // conflit attendu
      }

      // Précondition du test : package.json n'a JAMAIS été signalé en
      // conflit — c'est exactement le trou couvert par ce test.
      const conflicted = git(repo, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n");
      expect(conflicted).toEqual(["package-lock.json"]);

      process.chdir(repo);
      await cmdResolve([], { regenerate: true, verbose: true });

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("regenerate:");
      expect(output).toContain("success");

      const lockContent = readFileSync(join(repo, "package-lock.json"), "utf-8");
      const lock = JSON.parse(lockContent);
      // Le lockfile régénéré doit refléter `package.json` (version 1.0.0,
      // jamais modifié par le merge) — pas l'un ou l'autre côté du conflit
      // qu'on avait artificiellement injecté dans le vieux lockfile.
      expect(lock.version).toBe("1.0.0");
      expect(lockContent).not.toContain("<<<<<<<");

      const status = git(repo, ["status", "--short"]).trim();
      // package.json n'a jamais été touché par gitwand (il n'était pas en
      // conflit) — seul package-lock.json doit porter une modification.
      expect(status).toContain("package-lock.json");
    },
  );
});

function bumpLockVersion(repo: string, version: string): void {
  const path = join(repo, "package-lock.json");
  const lock = JSON.parse(readFileSync(path, "utf-8"));
  lock.version = version;
  lock.packages[""].version = version;
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}
