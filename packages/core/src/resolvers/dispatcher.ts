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
 *          ├─ isJsonFile(filePath) → tryResolveJsonConflict()
 *          ├─ isMarkdownFile(filePath) → tryResolveMarkdownConflict()
 *          └─ null → moteur textuel standard (resolver.ts switch)
 *
 * Chaque résolveur spécialisé retourne des lignes résolues ou null
 * (null = le résolveur ne sait pas → fallback).
 */

import type { ConflictHunk } from "../types.js";
import { tryResolveJsonConflict } from "./json.js";
import { tryResolveMarkdownConflict } from "./markdown.js";

// ─── Type detection ───────────────────────────────────────

/** Vérifie si le fichier est JSON ou JSONC */
export function isJsonFile(filePath: string): boolean {
  return /\.(json|jsonc)$/i.test(filePath);
}

/** Vérifie si le fichier est Markdown */
export function isMarkdownFile(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath);
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
  resolverUsed: "json" | "markdown" | "none";
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
  // ── JSON / JSONC ──────────────────────────────────────
  if (isJsonFile(filePath)) {
    const result = tryResolveJsonConflict(
      hunk.baseLines,
      hunk.oursLines,
      hunk.theirsLines,
    );

    if (result.merged !== null) {
      // Le résolveur JSON retourne une string (le JSON reformaté)
      // ou un objet — dans les deux cas on split en lignes
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

  // ── Pas de résolveur spécialisé ───────────────────────
  return {
    lines: null,
    reason: "Aucun résolveur spécialisé pour ce type de fichier.",
    resolverUsed: "none",
  };
}
