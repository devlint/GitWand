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
 *  2. superposer sur ce worktree chaque chemin déjà résolu (stage 0) de
 *     l'index de merge réel (`git checkout-index --all --force`, ciblé via
 *     `--work-tree`) — c'est ce qui rend visibles les fichiers qui n'existent
 *     QUE côté "theirs" (follow-up plan, résout la limitation identifiée par
 *     la revue finale du plan original — voir git blame pour l'historique).
 *  3. écraser dans ce worktree chaque source de vérité (`package.json`…)
 *     par son contenu déjà résolu en pass 1 (fourni par l'appelant — ce
 *     module ne re-résout rien).
 *  4. lancer la commande du registre (flags de suppression de scripts déjà
 *     bakés dans `ecosystem.command.args` — jamais surchargeables ici).
 *  5. sur succès : relire + valider le lockfile régénéré depuis le
 *     filesystem du worktree.
 *  6. `finally` : toujours supprimer le worktree, succès ou échec.
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
 * Fix round 1 (Important #2) — AGENTS.md : « Strip environment variables
 * that carry secrets… Pass only the specific env vars the child process
 * needs. » C'est la description d'une ALLOWLIST, pas d'une denylist — une
 * denylist par motif de nom a toujours des trous (`*_PRIVATE_KEY`,
 * `DATABASE_URL` avec un mot de passe embarqué, tout secret dont le nom ne
 * matche aucun des motifs prévus…). On liste donc explicitement ce dont
 * git/npm/pnpm/yarn/composer/cargo ont besoin pour tourner, plutôt que ce
 * qu'on essaie de deviner comme "sensible".
 *
 * `GIT_*` est inclus en bloc (préfixe) : c'est de la plomberie git, jamais
 * un secret, et le retirer casse `git worktree add` lui-même (régression
 * découverte en test : un environnement qui injecte `safe.directory` via
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_N`/`GIT_CONFIG_VALUE_N` échoue si l'un
 * des trois est retiré sans les deux autres — "fatal: unable to parse
 * command-line config").
 */
const ENV_ALLOWLIST_EXACT = new Set([
  // POSIX — nécessaires pour localiser les binaires, le HOME (~/.npmrc,
  // ~/.cargo, ~/.composer…) et un shell/locale cohérents.
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SHELL",
  // Windows — équivalents, seulement transmis s'ils sont effectivement définis.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ALLUSERSPROFILE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  // Emplacements toolchain non-standard — n'ont d'effet que si l'utilisateur
  // les a lui-même définis (rustup/cargo/pnpm/composer hors XDG par défaut).
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PNPM_HOME",
  "COMPOSER_HOME",
  "COMPOSER_CACHE_DIR",
  "npm_config_cache",
]);

/** Préfixes de noms de variables entièrement whitelistés (plomberie git). */
const ENV_ALLOWLIST_PREFIXES = ["GIT_"];

/**
 * Fix (final review, Finding 4) — `ENV_ALLOWLIST_PREFIXES` (`GIT_*`) était
 * jusqu'ici utilisé par LA MÊME fonction (`buildSpawnEnv`) pour LES DEUX
 * familles de spawn : la plomberie git (`git worktree add`/`remove`, où
 * `GIT_*` est effectivement nécessaire — voir le commentaire ci-dessus) ET
 * l'installeur de l'écosystème (npm/pnpm/yarn/composer/cargo), qui n'a
 * besoin d'AUCUNE de ces variables. Des systèmes CI injectent couramment des
 * identifiants via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
 * (ex: `http.extraheader=Authorization: Basic <token>`) ou
 * `GIT_ASKPASS`/`GIT_SSH_COMMAND` — laisser ces variables atteindre le
 * process spawné pour l'écosystème contredit la propre justification de
 * l'allowlist ("aucun token ne peut fuiter par un nom de variable qu'une
 * denylist aurait oublié") et AGENTS.md ("Pass only the specific env vars
 * the child process needs").
 *
 * Les 5 commandes du registre v1 sont toutes lockfile-only (jamais
 * d'installation complète) : aucune n'a besoin de résoudre une dépendance
 * `git+https://` via la config git héritée. On retire donc le préfixe
 * `GIT_*` ENTIÈREMENT pour ce builder plutôt que de tenter une liste
 * d'exclusions au sein du préfixe (plus simple à auditer, et le blast radius
 * d'un manque futur — une dépendance git+https qui échouerait proprement —
 * est bien moins grave qu'une fuite de credentials).
 */
function buildEcosystemSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!ENV_ALLOWLIST_EXACT.has(key)) continue;
    env[key] = value;
  }
  return env;
}

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
  /**
   * Alternate git index file to seed the disposable worktree from (via
   * `GIT_INDEX_FILE`), instead of `repoRoot`'s own live index. Omitted in
   * production (the real CLI always has a genuine in-progress merge whose
   * live index is exactly what should seed the worktree) — supplied by the
   * measurement harness, which has no real in-progress merge to read from.
   */
  seedIndexFile?: string;
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
 * Construit l'environnement des DEUX spawns de plomberie git (`git worktree
 * add`/`remove`/`prune`) à partir d'une ALLOWLIST explicite
 * (`ENV_ALLOWLIST_EXACT` + préfixe `GIT_*`), pas d'une denylist de motifs
 * "sensibles" — voir le commentaire de l'allowlist pour le pourquoi. Rien
 * d'autre du `process.env` de l'agent n'est transmis.
 *
 * Fix (final review, Finding 4) — ce builder (GIT_*-inclusif) ne doit PLUS
 * servir pour le spawn de l'installeur de l'écosystème (npm/pnpm/yarn/
 * composer/cargo) : voir `buildEcosystemSpawnEnv` ci-dessus et son
 * commentaire pour le pourquoi. Réservé à git désormais — d'où le renommage.
 */
function buildGitSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const allowed =
      ENV_ALLOWLIST_EXACT.has(key) || ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!allowed) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Fix (follow-up plan, "merge-index seeding") — step 1 still worktrees at
 * `HEAD` (a disposable, always-valid scaffold), but step 2 overlays every
 * already-resolved (stage-0) path from the REAL merge index on top of it —
 * this is what makes a `theirs`-only file (a new workspace member's
 * `package.json`, say) visible to the installer, and what stops the seed
 * lockfile from being biased toward `ours'` incremental state. Paths still
 * mid-conflict (multi-stage) are silently skipped by `checkout-index`; the
 * caller overwrites those explicitly via `resolvedSources` right after this
 * returns, so leaving them at their `HEAD` scaffold content is harmless.
 *
 * `seedIndexFile`, when given, points `checkout-index` at an alternate index
 * instead of `repoRoot`'s own live one — used by the measurement harness
 * (`scripts/replay-regenerate.mjs`) to replay a *historical* merge, which has
 * no real in-progress-merge index to read from.
 */
async function addWorktree(
  repoRoot: string,
  worktreeDir: string,
  seedIndexFile?: string,
): Promise<void> {
  await execFileAsync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], {
    cwd: repoRoot,
    env: buildGitSpawnEnv(),
  });

  const env = buildGitSpawnEnv();
  if (seedIndexFile) env.GIT_INDEX_FILE = seedIndexFile;
  await execFileAsync(
    "git",
    ["--work-tree", worktreeDir, "checkout-index", "--all", "--force"],
    { cwd: repoRoot, env },
  );
}

async function removeWorktree(repoRoot: string, worktreeDir: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], {
      cwd: repoRoot,
      env: buildGitSpawnEnv(),
    });
  } catch {
    // Best-effort fallback : le worktree n'est peut-être jamais devenu un
    // vrai worktree git (échec avant/pendant `git worktree add`) — on
    // s'assure quand même que rien ne reste sur disque.
    await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot, env: buildGitSpawnEnv() }).catch(() => {});
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
    await addWorktree(repoRoot, worktreeDir, params.seedIndexFile);
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
        env: buildEcosystemSpawnEnv(),
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
