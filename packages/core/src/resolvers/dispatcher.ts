/**
 * GitWand — Dispatcher de résolveurs par format
 *
 * Point d'entrée pour la résolution format-aware.
 * Détecte le type de fichier à partir de son chemin et tente une
 * résolution spécialisée avant de tomber en fallback sur le moteur textuel.
 *
 * Architecture :
 *
 *   resolver.ts
 *     └─ tryFormatAwareResolve(hunk, filePath)
 *          ├─ isJsonFile(filePath)    → tryResolveJsonConflict()
 *          ├─ isMarkdownFile(filePath) → tryResolveMarkdownConflict()
 *          ├─ isYamlFile(filePath)    → tryResolveYamlConflict()
 *          ├─ isImportFile(filePath)  → tryResolveImportConflict() (si bloc d'imports)
 *          ├─ isVueFile(filePath)     → tryResolveVueConflict()
 *          ├─ isCssFile(filePath)     → tryResolveCssConflict()
 *          └─ null → moteur textuel standard (resolver.ts switch)
 *
 * Chaque résolveur spécialisé retourne des lignes résolues ou null
 * (null = le résolveur ne sait pas → fallback).
 *
 * Phase 7.3b — Nouveaux résolveurs :
 *   - YAML (.yaml / .yml)
 *   - TS/JS imports (.ts / .js / .tsx / .jsx / .mjs / .cjs)
 *   - Vue SFC (.vue)
 *   - CSS/SCSS/Less (.css / .scss / .less)
 */

import type { ConflictHunk } from "../types.js";
import { tryResolveJsonConflict } from "./json.js";
import { tryResolveMarkdownConflict } from "./markdown.js";
import { tryResolveYamlConflict } from "./yaml.js";
import { tryResolveImportConflict, isImportBlock } from "./imports.js";
import { tryResolveVueConflict } from "./vue.js";
import { tryResolveCssConflict } from "./css.js";
import { tryResolveLockfileNpmConflict } from "./lockfile-npm.js";
import { tryResolveYarnLockConflict } from "./lockfile-yarn.js";
import { tryResolvePnpmLockConflict } from "./lockfile-pnpm.js";
import { tryResolveCargoConflict } from "./cargo.js";
import { tryResolveDotenvConflict } from "./dotenv.js";
import { tryResolveDockerfileConflict } from "./dockerfile.js";

// ─── Type detection ───────────────────────────────────────

/** Vérifie si le fichier est JSON ou JSONC */
export function isJsonFile(filePath: string): boolean {
  return /\.(json|jsonc)$/i.test(filePath);
}

/** Vérifie si le fichier est Markdown */
export function isMarkdownFile(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath);
}

/** Vérifie si le fichier est YAML */
export function isYamlFile(filePath: string): boolean {
  return /\.(ya?ml)$/i.test(filePath);
}

/** Vérifie si le fichier est un module TS/JS/JSX/TSX */
export function isJsFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath);
}

/** Vérifie si le fichier est un composant Vue SFC */
export function isVueFile(filePath: string): boolean {
  return /\.vue$/i.test(filePath);
}

/** Vérifie si le fichier est CSS, SCSS ou Less */
export function isCssFile(filePath: string): boolean {
  return /\.(css|scss|less|sass)$/i.test(filePath);
}

/** Vérifie si le fichier est un lockfile npm (package-lock.json) */
export function isNpmLockfile(filePath: string): boolean {
  return /package-lock\.json$/i.test(filePath);
}

/** Vérifie si le fichier est un lockfile yarn (yarn.lock) */
export function isYarnLockfile(filePath: string): boolean {
  return /yarn\.lock$/i.test(filePath);
}

/** Vérifie si le fichier est un lockfile pnpm (pnpm-lock.yaml) */
export function isPnpmLockfile(filePath: string): boolean {
  return /pnpm-lock\.ya?ml$/i.test(filePath);
}

/** Vérifie si le fichier est un lockfile quelconque */
export function isLockfile(filePath: string): boolean {
  return isNpmLockfile(filePath) || isYarnLockfile(filePath) || isPnpmLockfile(filePath);
}

/** Vérifie si le fichier est un Cargo.toml ou Cargo.lock */
export function isCargoFile(filePath: string): boolean {
  return /Cargo\.(toml|lock)$/i.test(filePath);
}

/** Vérifie si le fichier est un .env, .env.*, ou *.env */
export function isDotenvFile(filePath: string): boolean {
  return /(?:^|[\\/])\.env(?:\.|$)|\.env$/i.test(filePath);
}

/** Vérifie si le fichier est un Dockerfile */
export function isDockerfile(filePath: string): boolean {
  return /(?:^|[\\/])Dockerfile(?:\.|$)|\.dockerfile$/i.test(filePath);
}

// ─── Format-aware resolution result ──────────────────────

export interface FormatResolveResult {
  /** Lignes résolues, ou null si le résolveur n'a pas pu résoudre */
  lines: string[] | null;
  /**
   * Raison de la résolution (ou de l'échec).
   * Inclut le nom du résolveur et le détail.
   */
  reason: string;
  /** Résolveur utilisé (pour la trace) */
  resolverUsed: "json" | "markdown" | "yaml" | "imports" | "vue" | "css" | "lockfile-npm" | "lockfile-yarn" | "lockfile-pnpm" | "cargo" | "dotenv" | "dockerfile" | "none";
}

// ─── Main dispatcher ──────────────────────────────────────

/**
 * Tente de résoudre un hunk de conflit avec le résolveur approprié
 * selon le type de fichier.
 *
 * Retourne `lines !== null` si le résolveur a réussi, `null` sinon.
 * Dans tous les cas, `reason` décrit ce qui s'est passé.
 *
 * @param hunk - Le hunk de conflit à résoudre
 * @param filePath - Le chemin du fichier (pour déterminer le résolveur)
 */
export function tryFormatAwareResolve(
  hunk: ConflictHunk,
  filePath: string,
): FormatResolveResult {
  // ── Cargo.toml / Cargo.lock (avant JSON) ──────────────────
  if (isCargoFile(filePath)) {
    const result = tryResolveCargoConflict(
      filePath,
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.lines !== null) {
      return { lines: result.lines, reason: `[cargo] ${result.reason}`, resolverUsed: "cargo" };
    }
    return { lines: null, reason: `[cargo] ${result.reason}`, resolverUsed: "cargo" };
  }

  // ── .env / .env.* ─────────────────────────────────────────
  if (isDotenvFile(filePath)) {
    const result = tryResolveDotenvConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.lines !== null) {
      return { lines: result.lines, reason: `[dotenv] ${result.reason}`, resolverUsed: "dotenv" };
    }
    return { lines: null, reason: `[dotenv] ${result.reason}`, resolverUsed: "dotenv" };
  }

  // ── Dockerfile ────────────────────────────────────────────
  if (isDockerfile(filePath)) {
    const result = tryResolveDockerfileConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.lines !== null) {
      return { lines: result.lines, reason: `[dockerfile] ${result.reason}`, resolverUsed: "dockerfile" };
    }
    return { lines: null, reason: `[dockerfile] ${result.reason}`, resolverUsed: "dockerfile" };
  }

  // ── Lockfiles (avant JSON car package-lock.json est un .json) ──
  if (isNpmLockfile(filePath)) {
    const result = tryResolveLockfileNpmConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.merged !== null) {
      return {
        lines: result.merged.split("\n"),
        reason: `[lockfile-npm] ${result.reason}`,
        resolverUsed: "lockfile-npm",
      };
    }

    return {
      lines: null,
      reason: `[lockfile-npm] ${result.reason}`,
      resolverUsed: "lockfile-npm",
    };
  }

  if (isYarnLockfile(filePath)) {
    const result = tryResolveYarnLockConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.merged !== null) {
      return {
        lines: result.merged.split("\n"),
        reason: `[lockfile-yarn] ${result.reason}`,
        resolverUsed: "lockfile-yarn",
      };
    }

    return {
      lines: null,
      reason: `[lockfile-yarn] ${result.reason}`,
      resolverUsed: "lockfile-yarn",
    };
  }

  if (isPnpmLockfile(filePath)) {
    const result = tryResolvePnpmLockConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.merged !== null) {
      return {
        lines: result.merged.split("\n"),
        reason: `[lockfile-pnpm] ${result.reason}`,
        resolverUsed: "lockfile-pnpm",
      };
    }

    return {
      lines: null,
      reason: `[lockfile-pnpm] ${result.reason}`,
      resolverUsed: "lockfile-pnpm",
    };
  }

  // ── JSON / JSONC ──────────────────────────────────────
  if (isJsonFile(filePath)) {
    const result = tryResolveJsonConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.merged !== null) {
      const mergedText =
        typeof result.merged === "string"
          ? result.merged
          : JSON.stringify(result.merged, null, 2);

      return {
        lines: mergedText.split("\n"),
        reason: `[json] ${result.reason}`,
        resolverUsed: "json",
      };
    }

    return {
      lines: null,
      reason: `[json] ${result.reason}`,
      resolverUsed: "json",
    };
  }

  // ── Markdown ──────────────────────────────────────────
  if (isMarkdownFile(filePath)) {
    const result = tryResolveMarkdownConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.mergedLines !== null) {
      return {
        lines: result.mergedLines,
        reason: `[markdown] ${result.reason}`,
        resolverUsed: "markdown",
      };
    }

    return {
      lines: null,
      reason: `[markdown] ${result.reason}`,
      resolverUsed: "markdown",
    };
  }

  // ── YAML ──────────────────────────────────────────────
  if (isYamlFile(filePath)) {
    const result = tryResolveYamlConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.mergedLines !== null) {
      return {
        lines: result.mergedLines,
        reason: `[yaml] ${result.reason}`,
        resolverUsed: "yaml",
      };
    }

    return {
      lines: null,
      reason: `[yaml] ${result.reason}`,
      resolverUsed: "yaml",
    };
  }

  // ── Vue SFC ───────────────────────────────────────────
  if (isVueFile(filePath)) {
    const result = tryResolveVueConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.mergedLines !== null) {
      return {
        lines: result.mergedLines,
        reason: `[vue] ${result.reason}`,
        resolverUsed: "vue",
      };
    }

    return {
      lines: null,
      reason: `[vue] ${result.reason}`,
      resolverUsed: "vue",
    };
  }

  // ── CSS / SCSS / Less ─────────────────────────────────
  if (isCssFile(filePath)) {
    const result = tryResolveCssConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.mergedLines !== null) {
      return {
        lines: result.mergedLines,
        reason: `[css] ${result.reason}`,
        resolverUsed: "css",
      };
    }

    return {
      lines: null,
      reason: `[css] ${result.reason}`,
      resolverUsed: "css",
    };
  }

  // ── TS/JS/TSX/JSX — résolveur d'imports ──────────────
  // Uniquement si le bloc entier est composé d'import statements,
  // et uniquement si les deux côtés sont différents (si ours === theirs,
  // le moteur same_change gère la résolution sans réordonner les imports).
  if (isJsFile(filePath)) {
    if (
      isImportBlock(hunk.oursLines) &&
      isImportBlock(hunk.theirsLines) &&
      hunk.oursLines.join("\n") !== hunk.theirsLines.join("\n")
    ) {
      const result = tryResolveImportConflict(
        hunk.baseLines,
        hunk.oursLines,
        hunk.theirsLines,
      );

      if (result.mergedLines !== null) {
        return {
          lines: result.mergedLines,
          reason: `[imports] ${result.reason}`,
          resolverUsed: "imports",
        };
      }

      return {
        lines: null,
        reason: `[imports] ${result.reason}`,
        resolverUsed: "imports",
      };
    }
    // Bloc non-import → pas de résolveur spécialisé pour TS/JS (fallback textuel)
  }

  // ── Pas de résolveur spécialisé ───────────────────────
  return {
    lines: null,
    reason: "Aucun résolveur spécialisé pour ce type de fichier.",
    resolverUsed: "none",
  };
}
