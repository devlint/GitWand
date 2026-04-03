#!/usr/bin/env node

/**
 * GitWand CLI
 *
 * Usage:
 *   gitwand resolve [fichiers...]   Résout automatiquement les conflits triviaux
 *   gitwand status                  Affiche le statut des conflits dans le repo
 *   gitwand --help                  Affiche l'aide
 *
 * @example
 *   npx gitwand resolve
 *   npx gitwand resolve src/app.ts src/config.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { resolve } from "@gitwand/core";

// ─── ANSI Colors ────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const WAND = "✨";

function printBanner() {
  console.log(
    `\n${c.magenta}${c.bold}  ${WAND} GitWand${c.reset} ${c.dim}— Git's magic wand${c.reset}\n`,
  );
}

function printHelp() {
  printBanner();
  console.log(`${c.bold}Usage:${c.reset}`);
  console.log(`  gitwand resolve [fichiers...]   Résout les conflits triviaux`);
  console.log(`  gitwand status                  Affiche le statut des conflits`);
  console.log(`  gitwand --help                  Affiche cette aide`);
  console.log();
  console.log(`${c.bold}Options:${c.reset}`);
  console.log(`  --dry-run       Analyse sans écrire les fichiers`);
  console.log(`  --verbose       Affiche les détails de chaque résolution`);
  console.log(`  --no-whitespace Ne résout pas les conflits de whitespace`);
  console.log();
}

/**
 * Récupère la liste des fichiers en conflit dans le repo Git courant.
 */
function getConflictedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only --diff-filter=U", {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Commande principale : resolve
 */
function cmdResolve(files: string[], flags: Record<string, boolean>) {
  printBanner();

  // Si pas de fichiers spécifiés, chercher dans le repo
  if (files.length === 0) {
    files = getConflictedFiles();
    if (files.length === 0) {
      console.log(`${c.green}Aucun fichier en conflit détecté.${c.reset}`);
      return;
    }
    console.log(
      `${c.cyan}${files.length} fichier(s) en conflit détecté(s)${c.reset}\n`,
    );
  }

  let totalResolved = 0;
  let totalRemaining = 0;
  let totalConflicts = 0;

  for (const file of files) {
    const filePath = resolvePath(file);
    let content: string;

    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      console.log(`${c.red}  ✗ ${file} — fichier introuvable${c.reset}`);
      continue;
    }

    const result = resolve(content, file, {
      verbose: flags.verbose ?? false,
      resolveWhitespace: !(flags["no-whitespace"] ?? false),
    });

    totalConflicts += result.stats.totalConflicts;
    totalResolved += result.stats.autoResolved;
    totalRemaining += result.stats.remaining;

    if (result.stats.totalConflicts === 0) {
      console.log(`${c.dim}  ○ ${file} — aucun conflit${c.reset}`);
      continue;
    }

    const icon = result.stats.remaining === 0 ? "✓" : "◐";
    const color = result.stats.remaining === 0 ? c.green : c.yellow;

    console.log(
      `${color}  ${icon} ${file} — ${result.stats.autoResolved}/${result.stats.totalConflicts} résolus${c.reset}`,
    );

    // Afficher les détails en mode verbose
    if (flags.verbose) {
      for (const res of result.resolutions) {
        const status = res.autoResolved
          ? `${c.green}auto${c.reset}`
          : `${c.red}manuel${c.reset}`;
        console.log(
          `${c.dim}    L${res.hunk.startLine} [${res.hunk.type}] ${status} — ${res.hunk.explanation}${c.reset}`,
        );
      }
    }

    // Écrire le fichier résolu (sauf dry-run)
    if (!flags["dry-run"] && result.stats.autoResolved > 0) {
      const output = result.mergedContent ?? content;
      // Écrire seulement si on a résolu au moins quelque chose
      const resolvedContent =
        result.mergedContent ??
        // Reconstruire depuis les résolutions
        content; // TODO: reconstruire le contenu partiel
      writeFileSync(filePath, resolvedContent, "utf-8");
    }
  }

  // Résumé final
  console.log(`\n${c.bold}─── Résumé ───${c.reset}`);
  console.log(
    `${c.bold}${WAND} ${totalResolved}${c.reset} conflit(s) résolus automatiquement sur ${c.bold}${totalConflicts}${c.reset}`,
  );

  if (totalRemaining > 0) {
    console.log(
      `${c.yellow}${totalRemaining} conflit(s) restant(s) nécessitent une résolution manuelle${c.reset}`,
    );
  } else if (totalConflicts > 0) {
    console.log(
      `${c.green}${c.bold}Tous les conflits ont été résolus ! ${WAND}${c.reset}`,
    );
  }

  if (flags["dry-run"]) {
    console.log(`\n${c.dim}(dry-run — aucun fichier modifié)${c.reset}`);
  }

  console.log();
}

/**
 * Commande : status
 */
function cmdStatus() {
  printBanner();

  const files = getConflictedFiles();

  if (files.length === 0) {
    console.log(`${c.green}Aucun fichier en conflit.${c.reset}\n`);
    return;
  }

  console.log(`${c.cyan}${files.length} fichier(s) en conflit :${c.reset}\n`);

  for (const file of files) {
    const filePath = resolvePath(file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file);

      const resolvable = result.stats.autoResolved;
      const total = result.stats.totalConflicts;

      const pct = total > 0 ? Math.round((resolvable / total) * 100) : 0;
      const color = pct === 100 ? c.green : pct > 0 ? c.yellow : c.red;

      console.log(
        `  ${color}${file}${c.reset} — ${resolvable}/${total} résolvables (${pct}%)`,
      );
    } catch {
      console.log(`  ${c.red}${file}${c.reset} — erreur de lecture`);
    }
  }

  console.log();
}

// ─── Main ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

const flags: Record<string, boolean> = {};
const positional: string[] = [];

for (const arg of args.slice(1)) {
  if (arg.startsWith("--")) {
    flags[arg.slice(2)] = true;
  } else {
    positional.push(arg);
  }
}

if (!command || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "resolve") {
  cmdResolve(positional, flags);
} else if (command === "status") {
  cmdStatus();
} else {
  console.error(`${c.red}Commande inconnue : ${command}${c.reset}`);
  printHelp();
  process.exit(1);
}
