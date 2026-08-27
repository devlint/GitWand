/**
 * accuracy lot D — Exécuteur du tier de régénération, côté CLI.
 *
 * Le moteur (`@gitwand/core`) n'exécute jamais rien : il émet un
 * `RegenerationPlan` (donnée pure). C'est ce module qui, quand ce plan est
 * `runnable`, lance réellement la commande de l'écosystème (npm/pnpm/yarn
 * berry/composer/cargo) — dans un `git worktree` jetable, jamais dans
 * l'arbre de travail réel de l'utilisateur.
 *
 * Sandbox d'exécution (voir le brief de la tâche, § "Worktree sourcing") :
 *  1. `git worktree add --detach <tmp> HEAD` — HEAD est un point jetable,
 *     jamais la branche réelle de l'utilisateur.
 *  2. écraser dans ce worktree chaque source de vérité (`package.json`…)
 *     par son contenu déjà résolu en pass 1 (fourni par l'appelant — ce
 *     module ne re-résout rien).
 *  3. lancer la commande du registre (flags de suppression de scripts déjà
 *     bakés dans `ecosystem.command.args` — jamais surchargeables ici).
 *  4. sur succès : relire + valider le lockfile régénéré depuis le
 *     filesystem du worktree.
 *  5. `finally` : toujours supprimer le worktree, succès ou échec.
 *
 * Chaque tentative est tracée intégralement (commande, durée, code de
 * sortie) — cette provenance doit finir dans la raison de résolution
 * affichée à l'utilisateur (voir `commands/resolve.ts`).
 */

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { RegenEcosystem } from "@gitwand/core";

import { findGitRoot } from "./llm-config.js";

const execFileAsync = promisify(execFile);

/** Hôte utilisé pour la sonde hors-ligne, par écosystème `network: "required"`. */
const NETWORK_PROBE_HOSTS: Partial<Record<RegenEcosystem["id"], string>> = {
  npm: "registry.npmjs.org",
  pnpm: "registry.npmjs.org",
  "yarn-berry": "registry.yarnpkg.com",
  composer: "repo.packagist.org",
};

/** Budget de la sonde DNS hors-ligne — rapide, ne doit jamais bloquer longtemps. */
const OFFLINE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Motifs de noms de variables d'environnement considérées comme sensibles.
 * Volontairement délimité par des frontières `_`/début/fin de nom — une
 * regex `key`/`auth` nue matche aussi des variables de PLOMBERIE git tout à
 * fait légitimes (`GIT_CONFIG_KEY_0`, `GIT_CONFIG_COUNT`…, injectées par
 * certains environnements CI/sandbox pour porter `safe.directory`) et les
 * retirer casse `git worktree add` (`GIT_CONFIG_COUNT` sans son `KEY_N`
 * correspondant → "fatal: unable to parse command-line config"). On ne
 * strippe donc que les segments de nom qui ressemblent vraiment à un secret.
 */
const SECRET_ENV_PATTERN =
  /(?:^|_)(?:API_?KEYS?|ACCESS_KEYS?|SECRET_KEYS?|SECRETS?|TOKENS?|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i;

export type RegenerationOutcomeKind =
  | "success"
  | "missing-toolchain"
  | "offline"
  | "timeout"
  | "spawn-failed"
  | "validation-failed";

export interface RegenerationTrace {
  ecosystem: RegenEcosystem["id"];
  bin: string;
  args: string[];
  /** `bin` + `args` joints — pour affichage/log. */
  command: string;
  durationMs: number;
  /** `null` quand le process n'a jamais tourné (toolchain manquant, hors-ligne) ou a été tué (timeout). */
  exitCode: number | null;
}

export interface RegenerationOutcome {
  kind: RegenerationOutcomeKind;
  /** Contenu régénéré et validé — présent uniquement quand `kind === "success"`. */
  content: string | null;
  /** Raison lisible (français, cohérent avec les raisons de déclin du moteur). */
  reason: string;
  trace: RegenerationTrace;
}

export interface ResolvedSource {
  /** Chemin repo-relatif (ex: "package.json"). */
  path: string;
  /** Contenu déjà résolu (pass 1) à écrire dans le worktree jetable. */
  content: string;
}

export interface RegenerationRunParams {
  /** Racine du dépôt git réel — jamais écrite, seulement lue pour créer le worktree. */
  repoRoot: string;
  /** Chemin repo-relatif du fichier généré à régénérer (ex: "package-lock.json"). */
  file: string;
  ecosystem: RegenEcosystem;
  resolvedSources: ResolvedSource[];
  /** Surcharge de `ecosystem.defaultTimeoutMs` (tests notamment). */
  timeoutMs?: number;
}

function buildTrace(
  ecosystem: RegenEcosystem["id"],
  bin: string,
  args: string[],
  durationMs: number,
  exitCode: number | null,
): RegenerationTrace {
  return { ecosystem, bin, args, command: [bin, ...args].join(" "), durationMs, exitCode };
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** `which`/`where` — sonde de présence du binaire, jamais d'exécution réelle. */
export function isToolchainAvailable(bin: string): boolean {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(whichCmd, [bin], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sonde hors-ligne, rapide et sans dépendance : une résolution DNS du
 * registre de l'écosystème, bornée dans le temps. Pas de vérité absolue
 * (un DNS qui répond ne garantit pas que le registre soit joignable), mais
 * suffisant pour éviter une tentative de régénération vouée à l'échec quand
 * la machine n'a clairement aucune connectivité réseau — et bien plus
 * rapide/robuste qu'attendre le timeout complet de la commande elle-même.
 */
export async function isOffline(ecosystemId: RegenEcosystem["id"]): Promise<boolean> {
  const host = NETWORK_PROBE_HOSTS[ecosystemId];
  if (!host) return false; // pas de sonde connue pour cet écosystème → on ne bloque pas
  const probe = dnsLookup(host).then(
    () => false,
    () => true,
  );
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(true), OFFLINE_PROBE_TIMEOUT_MS);
  });
  return Promise.race([probe, timeout]);
}

/**
 * Validation du contenu régénéré — un parse réussi dans le format attendu
 * par l'écosystème. Ce n'est PAS une validation sémantique (lot B) : aucun
 * validateur réutilisable exporté par `@gitwand/core` ne couvre ces formats
 * de lockfile (`validateMergedContent` n'est pas exporté publiquement) ;
 * c'est le plancher documenté dans le brief de la tâche — un parse simple
 * avec les mêmes libs que le moteur utilise en interne (`yaml`, `smol-toml`).
 */
export function validateRegeneratedContent(
  ecosystemId: RegenEcosystem["id"],
  content: string,
): { valid: true } | { valid: false; error: string } {
  try {
    switch (ecosystemId) {
      case "npm":
      case "composer":
        JSON.parse(content);
        return { valid: true };
      case "pnpm":
      case "yarn-berry":
        parseYaml(content);
        return { valid: true };
      case "cargo":
        parseToml(content);
        return { valid: true };
    }
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Clone `process.env` en retirant toute variable dont le NOM ressemble à un
 * secret (token/clé/mot de passe/identifiant…) — l'outillage régénéré
 * (npm/pnpm/yarn/composer/cargo) n'a besoin de rien de tel pour un
 * `install --lockfile-only` script-suppressed ; ne jamais transmettre plus
 * que le strict nécessaire à un process spawné (règle AGENTS.md).
 */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

async function addWorktree(repoRoot: string, worktreeDir: string): Promise<void> {
  await execFileAsync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], {
    cwd: repoRoot,
    env: buildSpawnEnv(),
  });
}

async function removeWorktree(repoRoot: string, worktreeDir: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], {
      cwd: repoRoot,
      env: buildSpawnEnv(),
    });
  } catch {
    // Best-effort fallback : le worktree n'est peut-être jamais devenu un
    // vrai worktree git (échec avant/pendant `git worktree add`) — on
    // s'assure quand même que rien ne reste sur disque.
    await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot, env: buildSpawnEnv() }).catch(() => {});
  }
}

/**
 * Exécute le plan de régénération pour un fichier. Ne throw jamais — tout
 * échec (toolchain absent, hors-ligne, timeout, code de sortie non nul,
 * validation échouée) revient comme un `RegenerationOutcome` explicite,
 * jamais une exception qui remonterait jusqu'à `cmdResolve`.
 */
export async function runRegeneration(params: RegenerationRunParams): Promise<RegenerationOutcome> {
  const { repoRoot, file, ecosystem, resolvedSources } = params;
  const { bin, args } = ecosystem.command;
  const timeoutMs = params.timeoutMs ?? ecosystem.defaultTimeoutMs;

  // 1. Toolchain probe — avant tout worktree, échec rapide et sans effet de bord.
  if (!isToolchainAvailable(bin)) {
    return {
      kind: "missing-toolchain",
      content: null,
      reason: `outil « ${bin} » introuvable dans le PATH — régénération de "${file}" (${ecosystem.id}) impossible.`,
      trace: buildTrace(ecosystem.id, bin, args, 0, null),
    };
  }

  // 2. Hors-ligne — jamais de tentative partielle quand le réseau est requis.
  if (ecosystem.network === "required" && (await isOffline(ecosystem.id))) {
    return {
      kind: "offline",
      content: null,
      reason: `pas de connexion réseau détectée — régénération de "${file}" (${ecosystem.id}) nécessite un accès réseau, déclinée.`,
      trace: buildTrace(ecosystem.id, bin, args, 0, null),
    };
  }

  const worktreeDir = join(tmpdir(), `gitwand-regen-${randomUUID()}`);
  let worktreeCreated = false;

  try {
    await addWorktree(repoRoot, worktreeDir);
    worktreeCreated = true;

    // 3. Écrase les sources de vérité par leur contenu déjà résolu (pass 1) —
    // jamais l'état conflictuel brut de l'index de merge.
    for (const source of resolvedSources) {
      const dest = join(worktreeDir, source.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, source.content, "utf-8");
    }

    // 4. Spawn — args array uniquement, jamais d'interpolation shell.
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let spawnError: unknown = null;
    try {
      const res = await execFileAsync(bin, args, {
        cwd: worktreeDir,
        env: buildSpawnEnv(),
        timeout: timeoutMs,
        encoding: "utf-8",
        maxBuffer: 32 * 1024 * 1024,
      });
      stdout = res.stdout;
      stderr = res.stderr;
      exitCode = 0;
    } catch (err) {
      spawnError = err;
      const e = err as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      exitCode = typeof e.code === "number" ? e.code : null;
    }
    const durationMs = Date.now() - start;
    const trace = buildTrace(ecosystem.id, bin, args, durationMs, exitCode);

    if (spawnError !== null) {
      // Un process tué par le timeout n'a jamais de code de sortie propre ;
      // la durée écoulée (proche du budget alloué) est le signal fiable.
      const timedOut = durationMs >= timeoutMs;
      if (timedOut) {
        return {
          kind: "timeout",
          content: null,
          reason: `régénération de "${file}" via "${trace.command}" interrompue après ${formatDuration(durationMs)} (timeout ${formatDuration(timeoutMs)}) — conflit non résolu.`,
          trace,
        };
      }
      const detail = stderr.trim().split("\n").slice(0, 3).join(" | ");
      return {
        kind: "spawn-failed",
        content: null,
        reason: `régénération de "${file}" via "${trace.command}" a échoué (code ${exitCode ?? "?"}) — conflit non résolu.${detail ? ` ${detail}` : ""}`,
        trace,
      };
    }

    // 5. Succès du process — relire + valider le lockfile régénéré.
    const lockfilePath = join(worktreeDir, file);
    let regenerated: string;
    try {
      regenerated = await readFile(lockfilePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: "spawn-failed",
        content: null,
        reason: `régénération de "${file}" via "${trace.command}" (${formatDuration(durationMs)}) n'a produit aucun fichier lisible — conflit non résolu. ${msg}`,
        trace,
      };
    }

    const validation = validateRegeneratedContent(ecosystem.id, regenerated);
    if (!validation.valid) {
      return {
        kind: "validation-failed",
        content: null,
        reason: `régénération de "${file}" via "${trace.command}" (${formatDuration(durationMs)}) a produit un contenu invalide — conflit non résolu. ${validation.error}`,
        trace,
      };
    }

    return {
      kind: "success",
      content: regenerated,
      reason: `régénéré via ${trace.command} (${formatDuration(durationMs)}).`,
      trace,
    };
  } finally {
    if (worktreeCreated) {
      await removeWorktree(repoRoot, worktreeDir);
    } else {
      // `git worktree add` peut avoir échoué après avoir déjà créé le
      // répertoire cible (rare mais possible) — nettoyage défensif.
      await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ─── `.gitwandrc` `regenerate: true` — lecture CLI-only (§ ruling P-3) ────
//
// Le moteur (`@gitwand/core`) n'exécute jamais rien : ce champ n'a donc pas
// sa place dans `GitWandrcConfig`/`parseGitwandrc` (core), qui reste
// entièrement dédié au COMPORTEMENT DE RÉSOLUTION. On mirror ici le même
// pattern de découverte de fichier que `loadGitwandrcLlmConfig`
// (llm-config.ts) sans passer par `parseGitwandrc`, qui ignorerait ce champ.

/**
 * Lit `.gitwandrc`/`.gitwandrc.json` à la racine du dépôt git courant et
 * retourne `true` si `{ "regenerate": true }` y est déclaré. Tolérant :
 * repo introuvable, fichier absent, ou JSON invalide → `false`, jamais de
 * throw (même contrat que `loadGitwandrcLlmConfig`).
 */
export function loadGitwandrcRegenerateFlag(): boolean {
  const repoRoot = findGitRoot();
  if (repoRoot === null) return false;

  for (const filename of [".gitwandrc", ".gitwandrc.json"]) {
    const path = join(repoRoot, filename);
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && "regenerate" in parsed) {
        return (parsed as { regenerate?: unknown }).regenerate === true;
      }
      return false;
    } catch {
      continue;
    }
  }
  return false;
}
