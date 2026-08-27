/**
 * accuracy lot D — Tier de régénération, exécuteur CLI.
 *
 * Tout sur de vrais dépôts git temporaires ET de vrais binaires
 * npm/pnpm/composer/cargo quand ils sont disponibles sur la machine qui
 * lance les tests (`describe.skipIf` par écosystème absent) — jamais de
 * mock de la couche git ni des installeurs eux-mêmes, conformément aux
 * contraintes du repo.
 *
 * Rappel important sur les commandes du registre v1 (`packages/core`) :
 * elles sont volontairement des commandes "lockfile-only" qui METTENT À
 * JOUR un lockfile existant plutôt que d'en créer un depuis rien (c'est
 * particulièrement vrai pour `composer update --lock` qui échoue s'il n'y
 * a aucun `composer.lock` préexistant, et pour `cargo generate-lockfile`
 * qui exige un crate valide avec `src/main.rs`/`src/lib.rs`). Les repos de
 * test committent donc systématiquement un état HEAD valide et complet —
 * exactement le rôle que joue le `git worktree add --detach <tmp> HEAD`
 * en production : le worktree jetable démarre du dernier état connu-bon,
 * seules les "sources de vérité" (`package.json`…) sont écrasées par leur
 * contenu résolu en pass 1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGEN_ECOSYSTEMS, type RegenEcosystem } from "@gitwand/core";

import {
  runRegeneration,
  isToolchainAvailable,
  isOffline,
  validateRegeneratedContent,
  loadGitwandrcRegenerateFlag,
} from "../regenerate-runner.js";

// Environnement git HERMÉTIQUE — même raison que merge-context-detect.test.ts :
// sans ça, la config globale/système de la machine hôte (hooksPath, signature
// GPG, éditeur…) peut faire pendre `git worktree add`/`git commit` jusqu'au
// timeout du test.
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

function writeAndAdd(cwd: string, relPath: string, content: string): void {
  const abs = join(cwd, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  git(cwd, ["add", "--", relPath]);
}

function commit(cwd: string, msg: string): void {
  git(cwd, ["commit", "-m", msg]);
}

function listWorktrees(cwd: string): string {
  return git(cwd, ["worktree", "list", "--porcelain"]);
}

function ecosystemFor(id: RegenEcosystem["id"]): RegenEcosystem {
  const eco = REGEN_ECOSYSTEMS.find((e) => e.id === id);
  if (!eco) throw new Error(`registre : écosystème "${id}" introuvable`);
  return eco;
}

let repo: string;
let prevEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gw-regen-"));
  // `regenerate-runner.ts` construit l'environnement de ses propres spawns
  // (git worktree, installeurs) à partir de `process.env` — on le rend
  // hermétique pour la durée du test, même intention que HERMETIC_GIT_ENV
  // ci-dessus mais côté code sous test plutôt que côté harness.
  prevEnv = { ...process.env };
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
  });
});

afterEach(() => {
  process.env = prevEnv;
  rmSync(repo, { recursive: true, force: true });
});

// Tests d'intégration git + installeurs réels : macOS taxe chaque exec
// (XProtect) et un `npm install`/`composer update` réel peut prendre
// plusieurs centaines de ms même sans dépendance. Budget explicite.
const IT_TIMEOUT = { timeout: 30_000 };

describe("runRegeneration — success path (real toolchains)", () => {
  describe.skipIf(!isToolchainAvailable("npm"))("npm", () => {
    it("regenerates package-lock.json from a clean package.json", IT_TIMEOUT, async () => {
      initRepo(repo);
      const pkgJson = '{"name":"t","version":"1.0.0"}\n';
      writeAndAdd(repo, "package.json", pkgJson);
      commit(repo, "init");

      const outcome = await runRegeneration({
        repoRoot: repo,
        file: "package-lock.json",
        ecosystem: ecosystemFor("npm"),
        resolvedSources: [{ path: "package.json", content: pkgJson }],
      });

      expect(outcome.kind).toBe("success");
      expect(outcome.content).not.toBeNull();
      expect(() => JSON.parse(outcome.content as string)).not.toThrow();
      expect(outcome.trace.exitCode).toBe(0);
      expect(outcome.reason).toContain("régénéré via");
      expect(outcome.reason).toContain("npm install --package-lock-only --ignore-scripts");
      expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
    });
  });

  describe.skipIf(!isToolchainAvailable("pnpm"))("pnpm", () => {
    it("regenerates pnpm-lock.yaml from a clean package.json", IT_TIMEOUT, async () => {
      initRepo(repo);
      const pkgJson = '{"name":"t","version":"1.0.0"}\n';
      writeAndAdd(repo, "package.json", pkgJson);
      commit(repo, "init");

      const outcome = await runRegeneration({
        repoRoot: repo,
        file: "pnpm-lock.yaml",
        ecosystem: ecosystemFor("pnpm"),
        resolvedSources: [{ path: "package.json", content: pkgJson }],
      });

      expect(outcome.kind).toBe("success");
      expect(outcome.content).toContain("lockfileVersion");
      expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
    });
  });

  describe.skipIf(!isToolchainAvailable("composer"))("composer", () => {
    it("regenerates composer.lock from a clean composer.json (existing lock at HEAD)", IT_TIMEOUT, async () => {
      initRepo(repo);
      const composerJson = '{"name": "acme/test"}\n';
      writeAndAdd(repo, "composer.json", composerJson);
      // `composer update --lock` REFUSES to run without a pre-existing lock
      // file (message : "Cannot update lock file information without a lock
      // file present") — le worktree jetable checkout HEAD, qui doit donc
      // déjà avoir un composer.lock committé, exactement comme un vrai repo.
      const composerLock = JSON.stringify({ _readme: ["generated"], "content-hash": "x", packages: [], "packages-dev": [] });
      writeAndAdd(repo, "composer.lock", composerLock);
      commit(repo, "init");

      const outcome = await runRegeneration({
        repoRoot: repo,
        file: "composer.lock",
        ecosystem: ecosystemFor("composer"),
        resolvedSources: [{ path: "composer.json", content: composerJson }],
      });

      expect(outcome.kind).toBe("success");
      expect(() => JSON.parse(outcome.content as string)).not.toThrow();
      expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
    });
  });

  describe.skipIf(!isToolchainAvailable("cargo"))("cargo", () => {
    it("regenerates Cargo.lock from a clean Cargo.toml", IT_TIMEOUT, async () => {
      initRepo(repo);
      const cargoToml = '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n';
      writeAndAdd(repo, "Cargo.toml", cargoToml);
      // `cargo generate-lockfile` exige un crate valide (cible src/main.rs).
      writeAndAdd(repo, "src/main.rs", "fn main() {}\n");
      commit(repo, "init");

      const outcome = await runRegeneration({
        repoRoot: repo,
        file: "Cargo.lock",
        ecosystem: ecosystemFor("cargo"),
        resolvedSources: [{ path: "Cargo.toml", content: cargoToml }],
      });

      expect(outcome.kind).toBe("success");
      expect(outcome.content).toContain('name = "t"');
      expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
    });
  });
});

describe("runRegeneration — failure paths", () => {
  it("returns missing-toolchain when the ecosystem binary isn't on PATH", IT_TIMEOUT, async () => {
    initRepo(repo);
    writeAndAdd(repo, "package.json", "{}\n");
    commit(repo, "init");

    const fakeEcosystem: RegenEcosystem = {
      ...ecosystemFor("npm"),
      command: { bin: "gitwand-tool-that-does-not-exist-xyz", args: ["install"] },
    };

    const outcome = await runRegeneration({
      repoRoot: repo,
      file: "package-lock.json",
      ecosystem: fakeEcosystem,
      resolvedSources: [{ path: "package.json", content: "{}\n" }],
    });

    expect(outcome.kind).toBe("missing-toolchain");
    expect(outcome.content).toBeNull();
    expect(outcome.reason).toContain("introuvable dans le PATH");
    // Pas de worktree tenté du tout — la sonde toolchain échoue avant.
    expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
  });

  it("returns timeout when the command exceeds the configured budget", IT_TIMEOUT, async () => {
    initRepo(repo);
    writeAndAdd(repo, "package.json", "{}\n");
    commit(repo, "init");

    const fakeEcosystem: RegenEcosystem = {
      ...ecosystemFor("npm"),
      // "offline-capable" : ce test exerce le chemin timeout, pas la sonde
      // réseau (déjà couverte par `describe("isOffline")` plus bas).
      network: "offline-capable",
      command: { bin: "sleep", args: ["5"] },
      defaultTimeoutMs: 200,
    };

    const outcome = await runRegeneration({
      repoRoot: repo,
      file: "package-lock.json",
      ecosystem: fakeEcosystem,
      resolvedSources: [{ path: "package.json", content: "{}\n" }],
    });

    expect(outcome.kind).toBe("timeout");
    expect(outcome.content).toBeNull();
    expect(outcome.reason).toContain("timeout");
    expect(outcome.trace.durationMs).toBeGreaterThanOrEqual(180);
    expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
  });

  it("returns validation-failed when the regenerated file doesn't parse", IT_TIMEOUT, async () => {
    initRepo(repo);
    writeAndAdd(repo, "package.json", "{}\n");
    // Un `package-lock.json` préexistant à HEAD, que la "commande" (un
    // simple shell) écrase avec du contenu non-JSON — simule un installeur
    // qui exit 0 mais produit un lockfile corrompu.
    writeAndAdd(repo, "package-lock.json", "{}\n");
    commit(repo, "init");

    const fakeEcosystem: RegenEcosystem = {
      ...ecosystemFor("npm"),
      network: "offline-capable", // exerce validation, pas la sonde réseau
      command: { bin: "sh", args: ["-c", "echo not-json > package-lock.json"] },
    };

    const outcome = await runRegeneration({
      repoRoot: repo,
      file: "package-lock.json",
      ecosystem: fakeEcosystem,
      resolvedSources: [{ path: "package.json", content: "{}\n" }],
    });

    expect(outcome.kind).toBe("validation-failed");
    expect(outcome.content).toBeNull();
    expect(outcome.reason).toContain("contenu invalide");
    expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
  });

  it("returns spawn-failed on a non-zero exit code", IT_TIMEOUT, async () => {
    initRepo(repo);
    writeAndAdd(repo, "package.json", "{}\n");
    commit(repo, "init");

    const fakeEcosystem: RegenEcosystem = {
      ...ecosystemFor("npm"),
      network: "offline-capable", // exerce spawn-failed, pas la sonde réseau
      command: { bin: "sh", args: ["-c", "echo boom >&2; exit 3"] },
    };

    const outcome = await runRegeneration({
      repoRoot: repo,
      file: "package-lock.json",
      ecosystem: fakeEcosystem,
      resolvedSources: [{ path: "package.json", content: "{}\n" }],
    });

    expect(outcome.kind).toBe("spawn-failed");
    expect(outcome.content).toBeNull();
    expect(outcome.trace.exitCode).toBe(3);
    expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
  });
});

describe("validateRegeneratedContent", () => {
  it("accepts valid JSON for npm/composer", () => {
    expect(validateRegeneratedContent("npm", '{"a":1}').valid).toBe(true);
    expect(validateRegeneratedContent("composer", '{"a":1}').valid).toBe(true);
  });
  it("rejects invalid JSON for npm/composer", () => {
    expect(validateRegeneratedContent("npm", "not json").valid).toBe(false);
  });
  it("accepts valid YAML for pnpm/yarn-berry", () => {
    expect(validateRegeneratedContent("pnpm", "a: 1\nb: 2\n").valid).toBe(true);
    expect(validateRegeneratedContent("yarn-berry", "a: 1\n").valid).toBe(true);
  });
  it("accepts valid TOML for cargo", () => {
    expect(validateRegeneratedContent("cargo", '[package]\nname = "t"\n').valid).toBe(true);
  });
  it("rejects malformed TOML for cargo", () => {
    expect(validateRegeneratedContent("cargo", "[[[not toml").valid).toBe(false);
  });
});

describe("isToolchainAvailable", () => {
  it("finds a binary known to exist (git itself)", () => {
    expect(isToolchainAvailable("git")).toBe(true);
  });
  it("returns false for a binary that doesn't exist", () => {
    expect(isToolchainAvailable("gitwand-tool-that-does-not-exist-xyz")).toBe(false);
  });
});

describe("isOffline", () => {
  it("returns false immediately for an ecosystem with no probe host (cargo)", async () => {
    expect(await isOffline("cargo")).toBe(false);
  });

  it("returns true when the DNS lookup rejects", async () => {
    vi.doMock("node:dns/promises", () => ({ lookup: vi.fn().mockRejectedValue(new Error("ENOTFOUND")) }));
    vi.resetModules();
    const mod = await import("../regenerate-runner.js");
    await expect(mod.isOffline("npm")).resolves.toBe(true);
    vi.doUnmock("node:dns/promises");
    vi.resetModules();
  });
});

describe("loadGitwandrcRegenerateFlag", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("returns false when there is no .gitwandrc", IT_TIMEOUT, () => {
    initRepo(repo);
    writeAndAdd(repo, "a.txt", "x\n");
    commit(repo, "init");
    process.chdir(repo);
    expect(loadGitwandrcRegenerateFlag()).toBe(false);
  });

  it("returns true when .gitwandrc declares regenerate: true", IT_TIMEOUT, () => {
    initRepo(repo);
    writeAndAdd(repo, "a.txt", "x\n");
    commit(repo, "init");
    writeFileSync(join(repo, ".gitwandrc"), JSON.stringify({ regenerate: true }), "utf-8");
    process.chdir(repo);
    expect(loadGitwandrcRegenerateFlag()).toBe(true);
  });

  it("returns false when .gitwandrc declares regenerate: false", IT_TIMEOUT, () => {
    initRepo(repo);
    writeAndAdd(repo, "a.txt", "x\n");
    commit(repo, "init");
    writeFileSync(join(repo, ".gitwandrc"), JSON.stringify({ regenerate: false }), "utf-8");
    process.chdir(repo);
    expect(loadGitwandrcRegenerateFlag()).toBe(false);
  });
});
