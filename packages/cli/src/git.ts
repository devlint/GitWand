/**
 * Intégration Git — découverte des fichiers en conflit.
 *
 * `execSync` est volontairement utilisé (vs un appel asynchrone) car cet
 * appel est effectué une seule fois au démarrage d'une commande, avant
 * tout travail en parallèle. Un échec (hors repo git, binaire absent…)
 * est tolérant : on retourne une liste vide plutôt que de faire crasher
 * le CLI, ce qui laisse le comportement « aucun conflit détecté » prendre
 * le relais.
 */

import { execSync } from "node:child_process";

/**
 * Retourne la liste des fichiers en conflit dans le dépôt Git courant.
 *
 * S'appuie sur `git diff --name-only --diff-filter=U` (U = unmerged).
 * Retourne un tableau vide si Git est indisponible, si on n'est pas dans
 * un dépôt, ou si la commande échoue pour toute autre raison.
 */
export function getConflictedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only --diff-filter=U", {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f: string) => f.length > 0);
  } catch {
    return [];
  }
}


// ─── accuracy lot C — Détection du contexte de merge ──────────────────────────────────

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeContext } from "@gitwand/core";

/** `git rev-parse --git-dir`, résolu en chemin absolu (couvre les worktrees, où `.git` est un fichier). */
function gitDir(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function revName(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Détecte l'opération git en cours et construit le `MergeContext` correspondant.
 *
 * Convention des marqueurs git : « ours » est la branche DANS LAQUELLE on
 * intègre pour merge, rebase (ours = la branche sur laquelle on rebase) et
 * cherry-pick — donc `targetSide: "ours"` dans les trois cas. On le déclare
 * ici, explicitement, pour que le moteur n'ait jamais à re-dériver l'inversion
 * ours/theirs du rebase.
 *
 * Retourne `null` hors dépôt ou quand aucune opération n'est en cours — le
 * moteur retombe alors sur son comportement sans contexte (proposer plutôt
 * qu'appliquer sur les décisions dépendantes du contexte).
 */
export function detectMergeContext(cwd: string = process.cwd()): MergeContext | null {
  const dir = gitDir(cwd);
  if (!dir) return null;

  if (existsSync(join(dir, "MERGE_HEAD"))) {
    return {
      operation: "merge",
      targetSide: "ours",
      oursRef: revName(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      theirsRef: revName(cwd, ["name-rev", "--name-only", "--refs=refs/heads/*", "--refs=refs/remotes/*", "MERGE_HEAD"]),
    };
  }

  if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) {
    // Pendant un rebase : ours = la branche sur laquelle on rejoue (la cible),
    // theirs = le commit de l'utilisateur en cours de rejeu.
    const rebaseDir = existsSync(join(dir, "rebase-merge")) ? "rebase-merge" : "rebase-apply";
    return {
      operation: "rebase",
      targetSide: "ours",
      oursRef: revName(cwd, ["name-rev", "--name-only", "--refs=refs/heads/*", "--refs=refs/remotes/*", "HEAD"]),
      theirsRef: readRefFile(join(dir, rebaseDir, "head-name")),
    };
  }

  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) {
    return {
      operation: "cherry-pick",
      targetSide: "ours",
      oursRef: revName(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    };
  }

  if (existsSync(join(dir, "REVERT_HEAD"))) {
    return {
      operation: "revert",
      targetSide: "ours",
      oursRef: revName(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    };
  }

  return null;
}

/** Lit un fichier de ref du rebase (`head-name` contient `refs/heads/<branche>`). */
function readRefFile(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw.replace(/^refs\/heads\//, "") || undefined;
  } catch {
    return undefined;
  }
}
