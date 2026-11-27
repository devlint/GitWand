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
 *  - `const X = require('y')`, `const { a, b: c } = require('y')`  (CommonJS — liaisons lues)
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
  /** Leading whitespace of the source line (`raw` is trimmed). */
  indent?: string;
  /** The quote the module is written in (`'`, `"`), for an `import … from` line. */
  quote?: string;
}

// ─── Patterns de détection ────────────────────────────────

// import ... from 'module' ou "module"
const RE_IMPORT_FROM    = /^import\s+(type\s+)?(.+?)\s+from\s+(['"])(.+?)\3\s*;?\s*$/;
// import 'module' (side-effect)
const RE_IMPORT_SIDE    = /^import\s+['"](.+?)['"]\s*;?\s*$/;
// const X = require('module')
const RE_REQUIRE        = /^(?:const|let|var)\s+(\S.*?)\s*=\s*require\s*\(['"](.+?)['"]\)/;
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
  const stmt = parseTrimmed(line.trim());
  stmt.indent = /^\s*/.exec(line)?.[0] ?? "";
  return stmt;
}

function parseTrimmed(t: string): ImportStatement {

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
    const quote = fromMatch[3];
    const source = fromMatch[4];

    if (RE_NAMESPACE.test(specifier)) {
      const alias = specifier.replace(/^\*\s+as\s+/, "");
      return { raw: t, source, kind: "namespace", names: [alias], isType, quote };
    }

    const namedMatch = specifier.match(RE_NAMED_BLOCK);
    if (namedMatch) {
      const names = namedMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { raw: t, source, kind: "named", names, isType, quote };
    }

    // Default import (possibly with named: `import X, { Y }`)
    return { raw: t, source, kind: "default", names: [specifier], isType, quote };
  }

  // Re-export
  const exportMatch = t.match(RE_EXPORT_FROM);
  if (exportMatch) {
    return { raw: t, source: exportMatch[1], kind: "export", names: [], isType: false };
  }

  // CommonJS require
  const requireMatch = t.match(RE_REQUIRE);
  if (requireMatch) {
    // `names` : le motif de liaison tel qu'écrit (`fs`, `{ a, b: c }`). Un
    // autre déclarateur après le `require(…)` (`, b = require('n')`) n'est
    // pas lu : motif vide, donc liaisons inconnues (prudence).
    const moreDeclarators = hasTopLevelComma(t.slice(requireMatch[0].length));
    const pattern = moreDeclarators ? "" : requireMatch[1].trim();
    return { raw: t, source: requireMatch[2], kind: "require", names: [pattern], isType: false };
  }

  // Fallback : inconnu (commentaire, blank, multi-line…)
  return { raw: t, source: "", kind: "unknown", names: [], isType: false };
}

/**
 * Extract the deduped list of module specifiers imported by `content` (C0,
 * v3.6.0 — the PR-review dependency hop's extraction step; the resolved
 * import *graph* is explicitly out of scope until v4.0). Pure string work,
 * reuses the same regexes/`parseImport` as the conflict resolver above.
 * Scans every line of arbitrary file content (not just a contiguous import
 * block) — non-import lines are skipped, never throw.
 */
export function extractImportSources(content: string): string[] {
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    if (!isImportLike(line)) continue;
    const stmt = parseImport(line);
    if (stmt.source) seen.add(stmt.source);
  }
  return [...seen];
}

// ─── Merge engine ─────────────────────────────────────────

/** Résultat du merge d'imports */
export interface ImportMergeResult {
  /** Lignes fusionnées (null = conflit non résolvable) */
  mergedLines: string[] | null;
  /**
   * `true` quand `mergedLines` est null parce que les deux côtés ont AJOUTÉ un
   * import du même module qui déclare le même nom local de façons
   * incompatibles — un vrai conflit, que le moteur textuel ne doit pas
   * « résoudre » à son tour (il garderait les deux lignes : liaison en double).
   * Absent quand le résolveur ne s'applique simplement pas (bloc non-import,
   * ligne non parsable, formes différentes sans nom commun) ou quand les deux
   * côtés modifient la même ligne de base (le moteur textuel ne peut pas en
   * faire une union) : le moteur textuel peut alors prendre le relais.
   */
  conflict?: boolean;
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
 * Noms locaux déclarés par un import, ou `null` si on ne sait pas les lire.
 * `{ a, b as c, type d }` → a, c, d ; `X` → X ; `X, { Y }` → X, Y ;
 * `X, * as NS` → X, NS ; `* as NS` → NS ; side-effect et re-export → aucun ;
 * `require` : `const X = require(…)` → X, `const { a, b: c = 1 } = require(…)`
 * → a, c ; un motif imbriqué ou un tableau → null (prudence).
 */
function localBindings(stmt: ImportStatement): string[] | null {
  const fromSpecifier = (spec: string): string[] =>
    spec
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/).pop()!.trim());
  switch (stmt.kind) {
    case "named":
      return fromSpecifier(stmt.names.join(","));
    case "namespace":
      return [...stmt.names];
    case "default": {
      // `X`, `X, { Y, Z as W }` ou `X, * as NS`
      const spec = stmt.names[0] ?? "";
      return fromSpecifier(spec.replace(/[{}]/g, "").replace(/\*\s+as\s+/, ""));
    }
    case "side-effect":
    case "export":
      return [];
    case "require":
      return requireBindings(stmt.names[0] ?? "");
    default:
      return null;
  }
}

/**
 * Une virgule hors parenthèses, crochets, accolades et chaînes : un autre
 * déclarateur (`require('m').default, y = …`).
 */
function hasTopLevelComma(rest: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return true;
    else if (c === ";" && depth === 0) return false;
    else if (c === "/" && rest[i + 1] === "/") return false; // commentaire de fin de ligne
    else if (c === "/" && rest[i + 1] === "*") {
      // Commentaire bloc : sauté, un déclarateur peut suivre.
      const close = rest.indexOf("*/", i + 2);
      if (close < 0) return false;
      i = close + 1;
    }
  }
  return false;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Noms liés par le motif d'un `require` ; `null` quand on ne sait pas le lire. */
function requireBindings(pattern: string): string[] | null {
  const p = pattern.trim();
  if (IDENTIFIER.test(p)) return [p];
  const object = p.match(/^\{([^{}[\]]*)\}$/);
  if (!object) return null; // tableau, motif imbriqué
  const names: string[] = [];
  for (const part of object[1].split(",").map((s) => s.trim()).filter(Boolean)) {
    // `...rest`, `a`, `a = 1`, `a: b`, `a: b = 1`
    const name = part.replace(/^\.\.\./, "").split("=")[0].split(":").pop()!.trim();
    if (!IDENTIFIER.test(name)) return null;
    names.push(name);
  }
  return names;
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
      const semi = existing.raw.endsWith(";") ? ";" : "";
      const typePrefix = existing.isType ? "type " : "";
      const q = existing.quote ?? "'";
      const newRaw = `import ${typePrefix}{ ${sortedNames.join(", ")} } from ${q}${stmt.source}${q}${semi}`;
      namedBySource.set(key, {
        raw: newRaw,
        source: existing.source,
        kind: "named",
        names: sortedNames,
        isType: existing.isType,
        indent: existing.indent,
        quote: existing.quote,
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
  const indent = ours.indent ?? "";
  const semi = ours.raw.endsWith(";") ? ";" : "";

  if (sortedNames.length === 0) return null; // tous les noms supprimés

  // The file's own quotes (ours' line), not a house style.
  const q = ours.quote ?? "'";
  const oneLiner = `${indent}import ${typePrefix}{ ${sortedNames.join(", ")} } from ${q}${ours.source}${q}${semi}`;
  if (oneLiner.length <= 100 || sortedNames.length <= 3) return oneLiner;

  const lines = [
    `${indent}import ${typePrefix}{`,
    ...sortedNames.map((n) => `${indent}  ${n},`),
    `${indent}} from ${q}${ours.source}${q}${semi}`,
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
      reason: "The block contains lines that are not imports, so it falls back to the textual engine.",
      resolvedImports: 0,
      unresolvedImports: 1,
    };
  }

  // Garde anti-perte : les lignes `unknown` sont exclues du résultat fusionné.
  // C'est voulu pour les commentaires et lignes vides (le bloc est re-trié de
  // toute façon), mais tout AUTRE contenu import-like non parsable (ex:
  // `import a` sans from, syntaxe exotique) serait silencieusement supprimé —
  // dans le pire cas le resolver retournait "fusion réussie : 0 import(s)"
  // avec un bloc vide. Si un côté contient du contenu qu'on ne sait pas
  // représenter, on se déclare non applicable et on laisse le moteur textuel.
  const isBenignUnknown = (line: string): boolean => {
    const t = line.trim();
    return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
  };
  const hasUnparsableContent = (lines: string[]): boolean =>
    lines.some((l) => !isBenignUnknown(l) && parseImport(l).kind === "unknown");
  if (hasUnparsableContent(oursLines) || hasUnparsableContent(theirsLines)) {
    return {
      mergedLines: null,
      reason: "The block contains import-like lines that cannot be parsed, so it falls back to the textual engine rather than risk losing a line.",
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

  // Un `require` à plusieurs déclarateurs nouveau d'un côté ne dit que son
  // premier module ; si l'autre côté importe (de nouveau) l'un des modules
  // nommés plus loin sur la ligne, un nom peut être lié deux fois sans que la
  // suite le voie : conflit (prudence).
  // Commentaires retirés : un `require('x')` écrit dans un commentaire n'est
  // pas un déclarateur.
  const requiredOnLine = (raw: string): string[] =>
    [...raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").matchAll(/require\s*\(\s*['"](.+?)['"]\s*\)/g)].map(
      (m) => m[1],
    );
  const baseRawSet = new Set(baseImports.map((s) => s.raw));
  const multiClash = (mine: ImportStatement[], other: ImportStatement[]): ImportStatement | undefined => {
    for (const s of mine) {
      if (s.kind !== "require" || baseRawSet.has(s.raw)) continue;
      const modules = requiredOnLine(s.raw).slice(1);
      if (modules.length === 0) continue;
      const hit = other.find((o) => modules.includes(o.source) && !baseRawSet.has(o.raw));
      if (hit) return hit;
    }
    return undefined;
  };
  const multiHit = multiClash(oursImports, theirsImports) ?? multiClash(theirsImports, oursImports);
  if (multiHit) {
    return {
      mergedLines: null,
      conflict: true,
      reason: `Conflict on import '${multiHit.source}': it is also required on a line with several declarators, whose bindings are not all read.`,
      resolvedImports: 0,
      unresolvedImports: 1,
    };
  }

  // Deux imports d'un même côté avec la même clé (deux `require` du même
  // module, deux imports par défaut) : la map n'en garderait qu'un et l'autre
  // disparaîtrait du résultat. Seuls les imports named sont agrégés.
  const repeatsAKey = (imports: ImportStatement[]): boolean => {
    const keys = new Set<string>();
    for (const s of imports) {
      const key = importKey(s);
      if (keys.has(key)) return true;
      keys.add(key);
    }
    return false;
  };
  if (repeatsAKey(baseImports) || repeatsAKey(oursImports) || repeatsAKey(theirsImports)) {
    return {
      mergedLines: null,
      reason: "A side imports the same module twice in the same form, so it falls back to the textual engine rather than drop one.",
      resolvedImports: 0,
      unresolvedImports: 1,
    };
  }

  // Indexer par clé
  const baseMap   = new Map(baseImports.map((s) => [importKey(s), s]));
  const oursMap   = new Map(oursImports.map((s) => [importKey(s), s]));
  const theirsMap = new Map(theirsImports.map((s) => [importKey(s), s]));

  // Indexer par source (pour détecter les conflits cross-kind : namespace vs
  // default, même source). Toutes les déclarations d'un module comptent : un
  // côté peut en avoir plusieurs (`{ a, X }` et `type { T }`), et n'en garder
  // qu'une cachait la collision avec les autres.
  const bySource = (imports: ImportStatement[]) => {
    const map = new Map<string, ImportStatement[]>();
    for (const s of imports) map.set(s.source, [...(map.get(s.source) ?? []), s]);
    return map;
  };
  const oursBySource   = bySource(oursImports);
  const theirsBySource = bySource(theirsImports);

  // Un import identique à la base n'a pas été touché par ce côté. Quand l'autre
  // côté change la forme de ce même module (`{ x }` → `x`), c'est un changement
  // d'un seul côté, pas un conflit : l'import de base disparaît (supprimé par
  // l'autre côté, inchangé ici) et la nouvelle forme est gardée.
  const isUntouchedBase = (s: ImportStatement): boolean =>
    baseMap.get(importKey(s))?.raw === s.raw;

  // Deux imports du même module sous des formes différentes ne sont un vrai
  // conflit que s'ils déclarent le même nom local (`{ useAuth }` vs `useAuth`).
  // `import React from "react"` + `import { useState } from "react"` coexistent :
  // on se déclare alors non applicable, sans `conflict`, et le moteur textuel
  // garde les deux lignes comme avant.
  const bindingsCollide = (a: ImportStatement, b: ImportStatement): boolean => {
    const la = localBindings(a);
    const lb = localBindings(b);
    if (la === null || lb === null) return true; // liaisons inconnues : prudence
    return la.some((n) => lb.includes(n));
  };
  const kindMismatch = (a: ImportStatement, b: ImportStatement, source: string) => {
    unresolvedImports++;
    const typeVsValue = a.kind === b.kind && a.isType !== b.isType;
    return {
      mergedLines: null,
      ...(bindingsCollide(a, b) ? { conflict: true } : {}),
      reason: typeVsValue
        ? `Conflict on import '${source}': the same ${a.kind} import as a type on one side and as a value on the other.`
        : a.kind === b.kind
          ? `Conflict on import '${source}': each side imports it with different bindings.`
          : `Conflict on import '${source}': incompatible kinds (${a.kind} vs ${b.kind}).`,
      resolvedImports,
      unresolvedImports,
    };
  };

  /**
   * L'import de l'autre côté, du même module, qui rend `added` incompatible :
   * une autre clé (forme ou type/valeur), pas un import de base laissé tel quel. Parmi
   * plusieurs, celui dont les liaisons entrent en collision passe en premier,
   * pour que le conflit soit signalé. Un ajout `named` n'est pas comparé
   * (`import X` + `import { Y }` coexistent), sauf collision de liaisons.
   */
  const sameSourceClash = (
    added: ImportStatement,
    other: Map<string, ImportStatement[]>,
  ): ImportStatement | undefined => {
    // Une autre clé : autre forme, ou même forme en type d'un côté et en
    // valeur de l'autre (`{ X }` / `type { X }`, qui déclarent tous deux X).
    const candidates = (other.get(added.source) ?? []).filter(
      (s) => importKey(s) !== importKey(added) && !isUntouchedBase(s),
    );
    const colliding = candidates.find((s) => bindingsCollide(added, s));
    if (colliding) return colliding;
    return added.kind !== "named" ? candidates.find((s) => s.kind !== added.kind) : undefined;
  };

  // Ensemble de toutes les clés
  const allKeys = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);

  const resultLines: string[] = [];
  // Les imports gardés, pour la dernière garde sur les liaisons.
  const keptImports: ImportStatement[] = [];
  const keep = (stmt: ImportStatement) => {
    resultLines.push((stmt.indent ?? "") + stmt.raw);
    keptImports.push(stmt);
  };
  // A merged import written over several lines stays one entry until it is
  // sorted, so the sort moves it whole.
  const keepMerged = (text: string) => {
    resultLines.push(text);
    keptImports.push(parseImport(text.replace(/\n\s*/g, " ")));
  };
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
          keep(ours);
          resolvedImports++;
        } else if (ours.kind === "named" && theirs.kind === "named") {
          // Named imports du même module ajoutés des deux côtés → merger les noms
          const merged = mergeNamedImports(undefined, ours, theirs);
          if (merged) {
            keepMerged(merged);
            resolvedImports++;
          } else {
            unresolvedImports++;
            return {
              mergedLines: null,
              conflict: true,
              reason: `Conflict on the named import '${ours.source}': the names cannot be merged.`,
              resolvedImports,
              unresolvedImports,
            };
          }
        } else {
          // Structures incompatibles (ex: default vs namespace) → conflit
          return kindMismatch(ours, theirs, ours.source);
        }
      } else if (ours) {
        // Vérifier si theirs a un import du même module avec un kind incompatible
        const theirsClash = sameSourceClash(ours, theirsBySource);
        if (theirsClash) return kindMismatch(ours, theirsClash, ours.source);
        keep(ours);
        resolvedImports++;
      } else if (theirs) {
        // Vérifier si ours a un import du même module avec un kind incompatible
        const oursClash = sameSourceClash(theirs, oursBySource);
        if (oursClash) return kindMismatch(oursClash, theirs, theirs.source);
        keep(theirs);
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
          reason: `Conflict on import '${base.source}': ours deleted it, theirs modified it.`,
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
          reason: `Conflict on import '${base.source}': theirs deleted it, ours modified it.`,
          resolvedImports,
          unresolvedImports,
        };
      }
      continue;
    }

    // Les deux présents. Whitespace is not a change of the import (`raw` is
    // trimmed), but a side that re-indented the line keeps its indentation.
    const indent = ours.indent !== base.indent ? ours.indent : theirs.indent;
    const at = (stmt: ImportStatement): ImportStatement => ({ ...stmt, indent });
    if (!oursChanged && !theirsChanged) {
      keep(at(base));
      resolvedImports++;
    } else if (ours.raw === theirs.raw) {
      keep(at(ours));
      resolvedImports++;
    } else if (!oursChanged) {
      keep(at(theirs));
      resolvedImports++;
    } else if (!theirsChanged) {
      keep(at(ours));
      resolvedImports++;
    } else if (ours.kind === "named" && theirs.kind === "named") {
      // Named imports du même module modifiés des deux côtés → merger les noms
      const merged = mergeNamedImports(base, at(ours), theirs);
      if (merged) {
        keepMerged(merged);
        resolvedImports++;
      } else {
        unresolvedImports++;
        return {
          mergedLines: null,
          reason: `Conflict on the named imports from '${ours.source}'.`,
          resolvedImports,
          unresolvedImports,
        };
      }
    } else {
      unresolvedImports++;
      return {
        mergedLines: null,
        reason: `Conflict on import '${ours.source}': incompatible changes.`,
        resolvedImports,
        unresolvedImports,
      };
    }
  }

  // Dernière garde : deux imports gardés du même module qui lient le même nom
  // (chaque côté a changé un import de base différent : `{ a, X }` d'un côté,
  // `import X` de l'autre).
  const kept = keptImports;
  const baseRaws = new Set(baseImports.map((s) => s.raw.trim()));
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const [a, b] = [kept[i], kept[j]];
      if (!a.source || !b.source || a.raw === b.raw) continue;
      // Des liaisons illisibles (déjà hors des imports inchangés depuis la
      // base) comptent comme une collision, quel que soit le module : un
      // `require` à plusieurs déclarateurs peut lier le nom d'un autre import.
      if (a.source !== b.source && !bindingsCollide(a, b)) continue;
      // Un import resté tel quel depuis la base n'est le changement de personne
      // (comme dans `sameSourceClash`) : un `require` illisible inchangé ne
      // bloque pas une fusion que git ferait bien.
      if (baseRaws.has(a.raw) || baseRaws.has(b.raw)) continue;
      if (bindingsCollide(a, b)) {
        return {
          mergedLines: null,
          conflict: true,
          reason: a.source === b.source
            ? `Conflict on import '${a.source}': two imports kept from it bind the same name.`
            : `Conflict on imports '${a.source}' and '${b.source}': both bind the same name.`,
          resolvedImports,
          unresolvedImports: unresolvedImports + 1,
        };
      }
    }
  }

  // Trier les imports dans le résultat (ordre source : types first, puis alphabétique)
  const sortedResult = sortImportLines(resultLines).flatMap((entry) => entry.split("\n"));

  return {
    mergedLines: sortedResult,
    reason: `Import merge succeeded: ${resolvedImports} import(s) merged.`,
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
    stmt: parseImport(l.replace(/\n\s*/g, " ")),
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
