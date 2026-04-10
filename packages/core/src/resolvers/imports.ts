/**
 * GitWand — Résolveur d'imports TS/JS/TSX/JSX
 *
 * Résout les conflits dans les blocs d'imports ES/CommonJS/dynamic.
 * C'est l'un des types de conflits les plus courants en pratique : deux branches
 * ajoutent des imports différents en tête de fichier.
 *
 * Stratégie :
 *  1. Vérifier que le bloc de conflit est entièrement composé d'imports
 *     (+ lignes vides et commentaires — tolérés)
 *  2. Parser les imports des trois versions en statements normalisés
 *  3. Calculer l'union : imports de base + delta ours + delta theirs
 *  4. Si les deltas sont non-conflictuels → produire le bloc fusionné, trié
 *  5. Si conflit (même module importé différemment des deux côtés) → null (fallback)
 *
 * Formats supportés :
 *  - `import X from 'y'`
 *  - `import { X, Y } from 'y'`
 *  - `import * as X from 'y'`
 *  - `import 'y'` (side-effect import)
 *  - `import type { X } from 'y'` (TypeScript)
 *  - `const X = require('y')`  (CommonJS — détecté mais pas déstructuré)
 *  - `export { X } from 'y'`  (re-exports)
 */

// ─── Types internes ───────────────────────────────────────

/** Un import ES parsé */
export interface ImportStatement {
  /** Ligne source normalisée (sans whitespace de fin) */
  raw: string;
  /** Module source (ex: 'react', '../utils') */
  source: string;
  /** Type d'import : 'named', 'default', 'namespace', 'side-effect', 'require', 'export' */
  kind: "named" | "default" | "namespace" | "side-effect" | "require" | "export" | "unknown";
  /** Noms importés pour les named imports (ex: ['useState', 'useEffect']) */
  names: string[];
  /** `true` si c'est un `import type` TypeScript */
  isType: boolean;
}

// ─── Patterns de détection ────────────────────────────────

// import ... from 'module' ou "module"
const RE_IMPORT_FROM    = /^import\s+(type\s+)?(.+?)\s+from\s+['"](.+?)['"]\s*;?\s*$/;
// import 'module' (side-effect)
const RE_IMPORT_SIDE    = /^import\s+['"](.+?)['"]\s*;?\s*$/;
// const X = require('module')
const RE_REQUIRE        = /^(?:const|let|var)\s+\S.+?=\s*require\s*\(['"](.+?)['"]\)/;
// export { X } from 'module'
const RE_EXPORT_FROM    = /^export\s+(?:type\s+)?(?:[\w{*,\s]+)\s+from\s+['"](.+?)['"]\s*;?\s*$/;
// import * as X from 'module'
const RE_NAMESPACE      = /^\*\s+as\s+\w+$/;
// { X, Y } or { X as Y }
const RE_NAMED_BLOCK    = /^\{([^}]*)\}$/;

/**
 * Vérifie si une ligne est un import (ou commentaire/blanc tolérés dans un bloc d'imports).
 */
function isImportLike(line: string): boolean {
  const t = line.trim();
  return (
    t === "" ||
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    t.startsWith("*/") ||
    /^import\s/.test(t) ||
    /^export\s+(?:type\s+)?(?:\{|\*|[\w]+)\s+from\s/.test(t) ||
    /^(?:const|let|var)\s+\S.+?=\s*require\s*\(/.test(t)
  );
}

/**
 * Vérifie que toutes les lignes d'un bloc sont des imports/commentaires.
 */
export function isImportBlock(lines: string[]): boolean {
  return lines.every(isImportLike);
}

/**
 * Parse une ligne d'import en `ImportStatement`.
 */
function parseImport(line: string): ImportStatement {
  const t = line.trim();

  // Side-effect import
  const sideMatch = t.match(RE_IMPORT_SIDE);
  if (sideMatch) {
    return { raw: t, source: sideMatch[1], kind: "side-effect", names: [], isType: false };
  }

  // Named / default / namespace import
  const fromMatch = t.match(RE_IMPORT_FROM);
  if (fromMatch) {
    const isType = Boolean(fromMatch[1]);
    const specifier = fromMatch[2].trim();
    const source = fromMatch[3];

    if (RE_NAMESPACE.test(specifier)) {
      const alias = specifier.replace(/^\*\s+as\s+/, "");
      return { raw: t, source, kind: "namespace", names: [alias], isType };
    }

    const namedMatch = specifier.match(RE_NAMED_BLOCK);
    if (namedMatch) {
      const names = namedMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { raw: t, source, kind: "named", names, isType };
    }

    // Default import (possibly with named: `import X, { Y }`)
    return { raw: t, source, kind: "default", names: [specifier], isType };
  }

  // Re-export
  const exportMatch = t.match(RE_EXPORT_FROM);
  if (exportMatch) {
    return { raw: t, source: exportMatch[1], kind: "export", names: [], isType: false };
  }

  // CommonJS require
  const requireMatch = t.match(RE_REQUIRE);
  if (requireMatch) {
    return { raw: t, source: requireMatch[1], kind: "require", names: [], isType: false };
  }

  // Fallback : inconnu (commentaire, blank, multi-line…)
  return { raw: t, source: "", kind: "unknown", names: [], isType: false };
}

// ─── Merge engine ─────────────────────────────────────────

/** Résultat du merge d'imports */
export interface ImportMergeResult {
  /** Lignes fusionnées (null = conflit non résolvable) */
  mergedLines: string[] | null;
  /** Description de la fusion */
  reason: string;
  /** Nombre d'imports fusionnés */
  resolvedImports: number;
  /** Nombre de conflits non résolus */
  unresolvedImports: number;
}

/**
 * Clé d'identification d'un import : source + kind + isType.
 * Deux imports avec la même clé portent sur le même module de la même façon.
 */
function importKey(stmt: ImportStatement): string {
  return `${stmt.kind}:${stmt.source}:${stmt.isType ? "type" : "value"}`;
}

/**
 * Agrège les imports named multiples du même module en un seul import combiné.
 * Ex : [`import { useState } from 'react'`, `import { useEffect } from 'react'`]
 *    → [`import { useEffect, useState } from 'react'`]
 *
 * Cela résout le problème des Map keys en double quand plusieurs imports
 * du même module existent dans une version.
 */
function aggregateNamedImports(stmts: ImportStatement[]): ImportStatement[] {
  const result: ImportStatement[] = [];
  const namedBySource = new Map<string, ImportStatement>();

  for (const stmt of stmts) {
    if (stmt.kind !== "named") {
      result.push(stmt);
      continue;
    }

    const key = `${stmt.source}:${stmt.isType ? "type" : "value"}`;
    const existing = namedBySource.get(key);
    if (existing) {
      // Fusionner les noms
      const merged = new Set([...existing.names, ...stmt.names]);
      const sortedNames = [...merged].sort();
      const indent = existing.raw.match(/^(\s*)/)?.[1] ?? "";
      const semi = existing.raw.endsWith(";") ? ";" : "";
      const typePrefix = existing.isType ? "type " : "";
      const newRaw = `${indent}import ${typePrefix}{ ${sortedNames.join(", ")} } from '${stmt.source}'${semi}`;
      namedBySource.set(key, {
        raw: newRaw,
        source: existing.source,
        kind: "named",
        names: sortedNames,
        isType: existing.isType,
      });
    } else {
      namedBySource.set(key, stmt);
      result.push(stmt); // placeholder — sera remplacé plus bas
    }
  }

  // Reconstruire la liste en remplaçant les placeholders
  return result.map((stmt) => {
    if (stmt.kind !== "named") return stmt;
    const key = `${stmt.source}:${stmt.isType ? "type" : "value"}`;
    return namedBySource.get(key) ?? stmt;
  });
}

/**
 * Fusionne deux ensembles d'imports named du même module.
 * Ex : base={useState}, ours={useState,useEffect}, theirs={useState,useCallback}
 * → merged={useState,useEffect,useCallback}
 *
 * Retourne null si les imports ont des structures incompatibles (conflit sur des noms).
 */
function mergeNamedImports(
  base: ImportStatement | undefined,
  ours: ImportStatement,
  theirs: ImportStatement,
): string | null {
  if (ours.kind !== "named" || theirs.kind !== "named") return null;

  const baseNames = new Set(base?.names ?? []);
  const oursNames = new Set(ours.names);
  const theirsNames = new Set(theirs.names);

  // Calculer les deltas
  const oursAdded    = [...oursNames].filter((n) => !baseNames.has(n));
  const theirsAdded  = [...theirsNames].filter((n) => !baseNames.has(n));
  const oursRemoved  = [...baseNames].filter((n) => !oursNames.has(n));
  const theirsRemoved = [...baseNames].filter((n) => !theirsNames.has(n));

  // Conflit : un côté a supprimé un nom que l'autre a gardé (ou modifié autrement)
  for (const n of oursRemoved) {
    if (!theirsRemoved.includes(n)) {
      // Ours supprime n mais theirs garde n → conflict (can't auto-resolve)
      return null;
    }
  }
  for (const n of theirsRemoved) {
    if (!oursRemoved.includes(n)) {
      // Theirs supprime n mais ours garde n → conflict
      return null;
    }
  }

  // Pas de conflit : union des noms
  const merged = new Set([
    ...[...baseNames].filter((n) => !oursRemoved.includes(n)),
    ...oursAdded,
    ...theirsAdded,
  ]);

  const sortedNames = [...merged].sort();
  const typePrefix = ours.isType ? "type " : "";
  const indent = ours.raw.match(/^(\s*)/)?.[1] ?? "";
  const semi = ours.raw.endsWith(";") ? ";" : "";

  if (sortedNames.length === 0) return null; // tous les noms supprimés

  const oneLiner = `${indent}import ${typePrefix}{ ${sortedNames.join(", ")} } from '${ours.source}'${semi}`;
  if (oneLiner.length <= 100 || sortedNames.length <= 3) return oneLiner;

  const lines = [
    `${indent}import ${typePrefix}{`,
    ...sortedNames.map((n) => `${indent}  ${n},`),
    `${indent}} from '${ours.source}'${semi}`,
  ];
  return lines.join("\n");
}

/**
 * Fusionne deux blocs d'imports.
 *
 * @param baseLines   - Lignes de la version base (peut être vide pour diff2)
 * @param oursLines   - Lignes de la version ours
 * @param theirsLines - Lignes de la version theirs
 */
export function tryResolveImportConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): ImportMergeResult {
  // Vérifier que les trois blocs sont bien des imports
  if (!isImportBlock(oursLines) || !isImportBlock(theirsLines)) {
    return {
      mergedLines: null,
      reason: "Le bloc contient des lignes qui ne sont pas des imports — fallback textuel.",
      resolvedImports: 0,
      unresolvedImports: 1,
    };
  }

  // Parser les imports de chaque version
  // aggregateNamedImports combine les imports named multiples du même module en un seul,
  // ce qui évite les collisions de Map keys (ex: deux `import { X } from 'react'` séparés).
  const baseImports   = aggregateNamedImports(baseLines.map(parseImport).filter((s) => s.kind !== "unknown"));
  const oursImports   = aggregateNamedImports(oursLines.map(parseImport).filter((s) => s.kind !== "unknown"));
  const theirsImports = aggregateNamedImports(theirsLines.map(parseImport).filter((s) => s.kind !== "unknown"));

  // Indexer par clé
  const baseMap   = new Map(baseImports.map((s) => [importKey(s), s]));
  const oursMap   = new Map(oursImports.map((s) => [importKey(s), s]));
  const theirsMap = new Map(theirsImports.map((s) => [importKey(s), s]));

  // Indexer par source (pour détecter les conflits cross-kind : namespace vs default, même source)
  const oursBySource   = new Map(oursImports.map((s) => [s.source, s]));
  const theirsBySource = new Map(theirsImports.map((s) => [s.source, s]));

  // Ensemble de toutes les clés
  const allKeys = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);

  const resultLines: string[] = [];
  let resolvedImports = 0;
  let unresolvedImports = 0;

  for (const key of allKeys) {
    const base  = baseMap.get(key);
    const ours  = oursMap.get(key);
    const theirs = theirsMap.get(key);

    // Absent de base → ajout
    if (!base) {
      if (ours && theirs) {
        if (ours.raw === theirs.raw) {
          // Même ajout → garder une fois
          resultLines.push(ours.raw);
          resolvedImports++;
        } else if (ours.kind === "named" && theirs.kind === "named") {
          // Named imports du même module ajoutés des deux côtés → merger les noms
          const merged = mergeNamedImports(undefined, ours, theirs);
          if (merged) {
            resultLines.push(...merged.split("\n"));
            resolvedImports++;
          } else {
            unresolvedImports++;
            return {
              mergedLines: null,
              reason: `Conflit sur l'import named '${ours.source}' — impossible de fusionner les noms.`,
              resolvedImports,
              unresolvedImports,
            };
          }
        } else {
          // Structures incompatibles (ex: default vs namespace) → conflit
          unresolvedImports++;
          return {
            mergedLines: null,
            reason: `Conflit sur l'import '${ours.source}' — types incompatibles (${ours.kind} vs ${theirs.kind}).`,
            resolvedImports,
            unresolvedImports,
          };
        }
      } else if (ours) {
        // Vérifier si theirs a un import du même module avec un kind incompatible
        const theirsSameSource = theirsBySource.get(ours.source);
        if (theirsSameSource && theirsSameSource.kind !== ours.kind && ours.kind !== "named") {
          unresolvedImports++;
          return {
            mergedLines: null,
            reason: `Conflit sur l'import '${ours.source}' — types incompatibles (${ours.kind} vs ${theirsSameSource.kind}).`,
            resolvedImports,
            unresolvedImports,
          };
        }
        resultLines.push(ours.raw);
        resolvedImports++;
      } else if (theirs) {
        // Vérifier si ours a un import du même module avec un kind incompatible
        const oursSameSource = oursBySource.get(theirs.source);
        if (oursSameSource && oursSameSource.kind !== theirs.kind && theirs.kind !== "named") {
          unresolvedImports++;
          return {
            mergedLines: null,
            reason: `Conflit sur l'import '${theirs.source}' — types incompatibles (${oursSameSource.kind} vs ${theirs.kind}).`,
            resolvedImports,
            unresolvedImports,
          };
        }
        resultLines.push(theirs.raw);
        resolvedImports++;
      }
      continue;
    }

    // Présent dans base
    const oursChanged   = ours   ? ours.raw   !== base.raw : true;
    const theirsChanged = theirs ? theirs.raw !== base.raw : true;

    if (!ours && !theirs) {
      // Supprimé des deux côtés
      resolvedImports++;
      continue;
    }

    if (!ours) {
      if (!theirsChanged) {
        resolvedImports++; // theirs = base, ours supprimé → supprimer
      } else {
        unresolvedImports++;
        return {
          mergedLines: null,
          reason: `Conflit sur l'import '${base.source}' — ours l'a supprimé, theirs l'a modifié.`,
          resolvedImports,
          unresolvedImports,
        };
      }
      continue;
    }

    if (!theirs) {
      if (!oursChanged) {
        resolvedImports++; // ours = base, theirs supprimé → supprimer
      } else {
        unresolvedImports++;
        return {
          mergedLines: null,
          reason: `Conflit sur l'import '${base.source}' — theirs l'a supprimé, ours l'a modifié.`,
          resolvedImports,
          unresolvedImports,
        };
      }
      continue;
    }

    // Les deux présents
    if (!oursChanged && !theirsChanged) {
      resultLines.push(base.raw);
      resolvedImports++;
    } else if (ours.raw === theirs.raw) {
      resultLines.push(ours.raw);
      resolvedImports++;
    } else if (!oursChanged) {
      resultLines.push(theirs.raw);
      resolvedImports++;
    } else if (!theirsChanged) {
      resultLines.push(ours.raw);
      resolvedImports++;
    } else if (ours.kind === "named" && theirs.kind === "named") {
      // Named imports du même module modifiés des deux côtés → merger les noms
      const merged = mergeNamedImports(base, ours, theirs);
      if (merged) {
        resultLines.push(...merged.split("\n"));
        resolvedImports++;
      } else {
        unresolvedImports++;
        return {
          mergedLines: null,
          reason: `Conflit sur les named imports '${ours.source}'.`,
          resolvedImports,
          unresolvedImports,
        };
      }
    } else {
      unresolvedImports++;
      return {
        mergedLines: null,
        reason: `Conflit sur l'import '${ours.source}' — modifications incompatibles.`,
        resolvedImports,
        unresolvedImports,
      };
    }
  }

  // Trier les imports dans le résultat (ordre source : types first, puis alphabétique)
  const sortedResult = sortImportLines(resultLines);

  return {
    mergedLines: sortedResult,
    reason: `Fusion d'imports réussie : ${resolvedImports} import(s) fusionné(s).`,
    resolvedImports,
    unresolvedImports,
  };
}

// ─── Tri des imports ──────────────────────────────────────

/** Node.js built-in modules (sans le préfixe `node:`) */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** Stratégies de tri d'imports configurables */
export type ImportSortStrategy =
  | "default"           // built-in → npm → scoped → relative
  | "eslint-import"     // built-in → external → internal → parent → sibling → index
  | "type-last";        // même que default mais `import type` en fin de chaque groupe

/**
 * Groupes d'imports pour le tri.
 *
 * Groupe 0 : Node built-ins et `node:` prefix
 * Groupe 1 : Packages npm standard (non-scoped)
 * Groupe 2 : Packages npm scoped (@...)
 * Groupe 3 : Alias internes (ex: @/, ~/, #/)
 * Groupe 4 : Chemins relatifs parents (../)
 * Groupe 5 : Chemins relatifs siblings (./)
 * Groupe 6 : Index imports (.)
 */
function importGroup(source: string, strategy: ImportSortStrategy = "default"): number {
  if (!source) return 7;

  if (strategy === "eslint-import") {
    // Node built-ins
    if (source.startsWith("node:") || NODE_BUILTINS.has(source)) return 0;
    // External packages
    if (!source.startsWith(".") && !source.startsWith("@/") && !source.startsWith("~/") && !source.startsWith("#/")) return 1;
    // Internal aliases
    if (source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#/")) return 2;
    // Parent imports
    if (source.startsWith("..")) return 3;
    // Sibling imports
    if (source.startsWith("./")) return 4;
    // Index
    if (source === ".") return 5;
    return 1;
  }

  // Default strategy
  if (source.startsWith("node:") || NODE_BUILTINS.has(source)) return 0;
  if (source.startsWith(".")) return 3;
  if (source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#/")) return 2;
  if (source.startsWith("@")) return 1;
  return 1;
}

/**
 * Trie un bloc d'imports selon la stratégie choisie.
 *
 * Supporte l'insertion de lignes vides entre les groupes pour
 * respecter les conventions eslint-plugin-import.
 *
 * @param lines - Lignes d'imports à trier
 * @param strategy - Stratégie de tri (default: "default")
 * @param insertGroupSeparators - Insérer des lignes vides entre groupes (default: false)
 */
function sortImportLines(
  lines: string[],
  strategy: ImportSortStrategy = "default",
  insertGroupSeparators: boolean = false,
): string[] {
  // Séparer les commentaires / blancs des imports réels
  const parsed = lines.map((l) => ({
    line: l,
    stmt: parseImport(l),
  }));

  const comments = parsed.filter((p) => p.stmt.kind === "unknown");
  const imports  = parsed.filter((p) => p.stmt.kind !== "unknown");

  // Trier
  imports.sort((a, b) => {
    const ga = importGroup(a.stmt.source, strategy);
    const gb = importGroup(b.stmt.source, strategy);
    if (ga !== gb) return ga - gb;

    // type-last : dans un même groupe, les `import type` vont à la fin
    if (strategy === "type-last") {
      if (a.stmt.isType !== b.stmt.isType) return a.stmt.isType ? 1 : -1;
    }

    return a.stmt.source.localeCompare(b.stmt.source);
  });

  // Recombiner
  const result: string[] = [...comments.map((p) => p.line)];

  if (insertGroupSeparators && imports.length > 0) {
    let lastGroup = importGroup(imports[0].stmt.source, strategy);
    for (const imp of imports) {
      const g = importGroup(imp.stmt.source, strategy);
      if (g !== lastGroup) {
        result.push(""); // ligne vide entre groupes
        lastGroup = g;
      }
      result.push(imp.line);
    }
  } else {
    result.push(...imports.map((p) => p.line));
  }

  return result;
}
