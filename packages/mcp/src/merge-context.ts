/**
 * accuracy lot C — Détection du contexte de merge pour les tools MCP.
 *
 * Volontairement dupliqué depuis `@gitwand/cli` (src/git.ts) plutôt
 * qu'importé : le MCP ne dépend pas du CLI, et `@gitwand/core` reste sans
 * dépendance Node (il tourne dans le navigateur). Les deux copies suivent la
 * même convention — « ours » est la branche CIBLE pour merge, rebase ET
 * cherry-pick, déclaré via `targetSide` pour que le moteur n'ait jamais à
 * re-dériver l'inversion ours/theirs du rebase.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeContext } from "@gitwand/core";

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

function readRefFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8").trim().replace(/^refs\/heads\//, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Détecte l'opération git en cours dans `cwd`. `null` = aucune / hors dépôt. */
export function detectMergeContext(cwd: string): MergeContext | null {
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
    const rebaseDir = existsSync(join(dir, "rebase-merge")) ? "rebase-merge" : "rebase-apply";
    return {
      operation: "rebase",
      targetSide: "ours",
      oursRef: revName(cwd, ["name-rev", "--name-only", "--refs=refs/heads/*", "--refs=refs/remotes/*", "HEAD"]),
      theirsRef: readRefFile(join(dir, rebaseDir, "head-name")),
    };
  }
  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) {
    return { operation: "cherry-pick", targetSide: "ours", oursRef: revName(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) };
  }
  if (existsSync(join(dir, "REVERT_HEAD"))) {
    return { operation: "revert", targetSide: "ours", oursRef: revName(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) };
  }
  return null;
}
