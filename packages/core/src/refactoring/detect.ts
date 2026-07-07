/**
 * GitWand v2.6 — Détection de refactorings (expérimental)
 *
 * Détecte les refactorings entre la version de base d'un fichier et une branche
 * (ours ou theirs). Utilisé par le pipeline RefMerge avant la résolution textuelle.
 *
 * ## Algorithme
 *
 * La détection est **purement textuelle** (zero dépendance, compatible browser) :
 *
 * ### rename-local / rename-top-level
 * 1. Tokeniser base et branch en listes d'identifiants (sans mots-clés).
 * 2. Identifier les tokens présents uniquement dans base (`removed`) et
 *    uniquement dans branch (`added`).
 * 3. Pour chaque paire (oldName, newName) dont le compte d'occurrences est
 *    identique ET unique dans le groupe, construire une substitution candidate.
 * 4. Appliquer toutes les substitutions simultanément sur la séquence base.
 * 5. Si la séquence obtenue == séquence branch : les renames sont confirmés.
 * 6. Classifier rename-local vs rename-top-level selon le contexte syntaxique.
 *
 * ### move-method
 * Parser léger ligne par ligne pour extraire `Map<className → Set<methodName>>`.
 * Détecter les méthodes ayant changé de classe entre base et branch.
 *
 * ## Garanties
 * - Retourne `[]` en cas d'erreur ou d'absence de tree-sitter (safe by default).
 * - Zéro import Node.js — compatible browser, Node.js, Tauri WebView.
 * - Complexité O(n) sur la longueur du code (n = nombre de tokens).
 */

import type { Refactoring } from "../types.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

/**
 * Regex des identifiants JavaScript/TypeScript valides.
 * Capture les noms de variables, fonctions, classes, paramètres.
 * Reset de lastIndex requis avant chaque utilisation (flag `g`).
 */
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Mots-clés JS/TS exclus de la détection de renommage.
 * Un mot-clé ne peut pas être "renommé" — ce serait un faux positif.
 */
const KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "bigint", "boolean", "break",
  "case", "catch", "class", "const", "constructor", "continue", "debugger",
  "declare", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "infer", "instanceof", "interface", "intrinsic", "is",
  "keyof", "let", "module", "namespace", "never", "new", "null", "number",
  "object", "of", "out", "override", "package", "private", "protected",
  "public", "readonly", "require", "return", "satisfies", "set", "static",
  "string", "super", "switch", "symbol", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "unique", "unknown", "using", "var", "void",
  "while", "with", "yield",
]);

// ─── Utilitaires de tokenisation ─────────────────────────────────────────────

/**
 * Remplace le contenu des string/template literals ET des commentaires par des
 * espaces, pour que `IDENT_RE` ne matche jamais une valeur entre guillemets ou
 * un mot de commentaire comme un identifiant renommable. Sans ça, un simple
 * changement de valeur (`"info"` → `"warn"`) ou de wording de commentaire
 * (`// use info level` → `// use warn level`) ressemble à un renommage
 * bijectif et `refactoring_aware_merge` le "résout" silencieusement à tort
 * (confiance 82) au lieu de le laisser à `complex`/LLM.
 *
 * Le scan gère strings et commentaires dans la même passe — indispensable pour
 * qu'un `//` à l'intérieur d'une string (URL) ne soit pas pris pour un début
 * de commentaire, et qu'un guillemet dans un commentaire n'ouvre pas une
 * string. Scan naïf caractère par caractère (pas un vrai lexer) — gère
 * l'échappement `\"` de base. Limitations connues : les interpolations
 * `${expr}` d'un template literal sont masquées avec le reste, et un `/` de
 * division suivi d'un autre `/` (regex vs commentaire) n'est pas désambiguïsé
 * — acceptable pour un pattern expérimental/best-effort qui dégrade déjà
 * silencieusement en cas d'échec.
 */
function maskStringsAndComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      result += quote;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < text.length) {
          // Escaped char (e.g. `\"`) — mask both, never a quote boundary.
          result += "  ";
          i += 2;
          continue;
        }
        result += text[i] === "\n" ? "\n" : " "; // preserve newlines (line count/positions)
        i++;
      }
      if (i < text.length) {
        result += quote; // closing quote
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      // Line comment — mask through end of line (newline preserved).
      while (i < text.length && text[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // Block comment — mask through `*/`, preserving newlines.
      result += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        result += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) {
        result += "  "; // closing */
        i += 2;
      }
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Extrait la liste ordonnée des identifiants non-mot-clé d'un bloc de code.
 * L'ordre est préservé — c'est la "séquence de tokens" utilisée pour la
 * vérification de substitution bijective.
 */
function tokenize(lines: string[]): string[] {
  const text = maskStringsAndComments(lines.join("\n"));
  const tokens: string[] = [];
  IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT_RE.exec(text)) !== null) {
    const tok = m[0];
    if (!KEYWORDS.has(tok)) tokens.push(tok);
  }
  return tokens;
}

/** Compte les occurrences de chaque token. */
function freqMap(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const tok of tokens) map.set(tok, (map.get(tok) ?? 0) + 1);
  return map;
}

/** Vérifie l'égalité élément par élément de deux tableaux de strings. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Échappe les caractères spéciaux pour une utilisation dans un RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Génère toutes les permutations d'un tableau de strings.
 * Utilisé pour résoudre les groupes de renommages ambigus (même count d'occurrences).
 * Limité à des tableaux de taille ≤ 4 (max 24 permutations) pour éviter l'explosion combinatoire.
 */
function permutations(arr: string[]): string[][] {
  if (arr.length <= 1) return [[...arr]];
  const result: string[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const first = arr[i]!;
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([first, ...perm]);
    }
  }
  return result;
}

/**
 * Cherche récursivement une assignation valide (substMap) pour les groupes ambigus.
 * Pour chaque groupe ambigu restant, essaie toutes les permutations de `news`
 * et valide via la vérification bijective complète.
 *
 * @returns La substMap complète si une assignation valide est trouvée, sinon null.
 */
function resolveAmbiguous(
  baseToks: string[],
  branchToks: string[],
  current: Map<string, string>,
  remaining: Array<{ olds: string[]; news: string[] }>,
): Map<string, string> | null {
  if (remaining.length === 0) {
    // Vérification bijective finale : toutes les substitutions appliquées simultanément
    const substituted = baseToks.map((t) => current.get(t) ?? t);
    return arraysEqual(substituted, branchToks) ? current : null;
  }

  const [group, ...rest] = remaining as [{ olds: string[]; news: string[] }, ...typeof remaining];
  for (const perm of permutations(group.news)) {
    const candidate = new Map(current);
    for (let i = 0; i < group.olds.length; i++) {
      candidate.set(group.olds[i]!, perm[i]!);
    }
    const result = resolveAmbiguous(baseToks, branchToks, candidate, rest);
    if (result !== null) return result;
  }
  return null;
}

// ─── Détection de renommages ──────────────────────────────────────────────────

/**
 * Détecte les renommages uniformes entre base et branch.
 *
 * Algorithme de substitution bijective simultanée :
 * 1. Tokens présents uniquement dans base → candidats `oldName`.
 * 2. Tokens présents uniquement dans branch → candidats `newName`.
 * 3. Grouper par nombre d'occurrences. Un groupe est "non ambigu" ssi
 *    exactement un oldName et un newName ont ce compte (signal fort).
 * 4. Appliquer toutes les substitutions simultanément sur baseToks.
 * 5. Si la séquence résultante == branchToks : tous les renames sont confirmés.
 *
 * Cette vérification simultanée gère correctement le cas multi-rename
 * (ex: deux variables renommées en même temps dans le même hunk).
 */
function detectRenames(
  baseLines: string[],
  branchLines: string[],
  max: number,
): Refactoring[] {
  const baseToks = tokenize(baseLines);
  const branchToks = tokenize(branchLines);

  if (baseToks.length === 0 || branchToks.length === 0) return [];

  const baseFreq = freqMap(baseToks);
  const branchFreq = freqMap(branchToks);

  // Tokens uniquement dans base (disparus → anciens noms candidats)
  const onlyInBase = [...baseFreq.entries()].filter(([tok]) => !branchFreq.has(tok));
  // Tokens uniquement dans branch (apparus → nouveaux noms candidats)
  const onlyInBranch = new Map(
    [...branchFreq.entries()].filter(([tok]) => !baseFreq.has(tok)),
  );

  if (onlyInBase.length === 0 || onlyInBranch.size === 0) return [];

  // Grouper par compte d'occurrences pour la correspondance non-ambiguë
  const byCount = new Map<number, { old: string[]; next: string[] }>();
  for (const [tok, cnt] of onlyInBase) {
    const g = byCount.get(cnt) ?? { old: [], next: [] };
    g.old.push(tok);
    byCount.set(cnt, g);
  }
  for (const [tok, cnt] of onlyInBranch) {
    const g = byCount.get(cnt) ?? { old: [], next: [] };
    g.next.push(tok);
    byCount.set(cnt, g);
  }

  // Construire la map de substitution.
  // Groupes non-ambigus (1 old → 1 new) : assignation directe.
  // Groupes ambigus (plusieurs olds/news avec le même count) : on tente toutes
  // les permutations via resolveAmbiguous() et la vérification bijective finale.
  const unambiguousMap = new Map<string, string>();
  const ambiguousGroups: Array<{ olds: string[]; news: string[] }> = [];

  for (const { old, next } of byCount.values()) {
    if (old.length === 1 && next.length === 1) {
      unambiguousMap.set(old[0]!, next[0]!);
    } else if (old.length === next.length && old.length >= 2 && old.length <= 4) {
      // Même cardinalité — potentiellement bijectif, à résoudre par permutation
      ambiguousGroups.push({ olds: old, news: next });
    }
    // Cardinalités différentes → pas bijectif, ignoré
  }

  if (unambiguousMap.size === 0 && ambiguousGroups.length === 0) return [];

  // Trouver une assignation valide (vérification bijective sur la séquence complète)
  const substMap = resolveAmbiguous(baseToks, branchToks, unambiguousMap, ambiguousGroups);
  if (!substMap) return [];

  // Tous les renames sont confirmés — construire les objets Refactoring
  const results: Refactoring[] = [];
  for (const [oldName, newName] of substMap) {
    if (results.length >= max) break;
    const kind = classifyRenameKind(baseLines, oldName);
    results.push({
      kind,
      oldName,
      newName,
      scope: kind === "rename-local" ? extractScope(baseLines, oldName) : undefined,
    });
  }
  return results;
}

/**
 * Classifie un renommage en "rename-local" ou "rename-top-level".
 *
 * Heuristique : si le symbole apparaît comme nom dans une déclaration
 * `function X`, `class X`, `async function X`, ou `export function X`
 * au niveau top-level (début de ligne, indentation minimale), c'est top-level.
 *
 * Sinon : on suppose que c'est un renommage local (variable, paramètre).
 */
function classifyRenameKind(
  baseLines: string[],
  name: string,
): "rename-local" | "rename-top-level" {
  const escapedName = escapeRegex(name);
  const topLevel = new RegExp(
    `^[ \\t]{0,2}(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class)\\s+${escapedName}\\b`,
    "m",
  );
  const text = baseLines.join("\n");
  return topLevel.test(text) ? "rename-top-level" : "rename-local";
}

/**
 * Extrait le nom de la fonction englobante (portée) d'un renommage local.
 *
 * Utilisé pour remplir `Refactoring.scope` → permet à `invert.ts` de
 * limiter la substitution inverse à la bonne portée lors du rejeu.
 *
 * Stratégie : cherche la dernière déclaration de fonction `function X(`
 * ou `const X = (` qui précède la première occurrence du symbole renommé.
 */
function extractScope(baseLines: string[], name: string): string | undefined {
  const text = baseLines.join("\n");
  const nameIdx = text.indexOf(name);
  if (nameIdx === -1) return undefined;

  const before = text.slice(0, nameIdx);

  // Pattern 1 : `function X(` ou `async function X(`
  const funcMatches = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)];
  if (funcMatches.length > 0) {
    return funcMatches[funcMatches.length - 1][1];
  }

  // Pattern 2 : `const/let X = (` → arrow function
  const arrowMatches = [...before.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)];
  if (arrowMatches.length > 0) {
    return arrowMatches[arrowMatches.length - 1][1];
  }

  return undefined;
}

// ─── Détection de move-method ─────────────────────────────────────────────────

/**
 * Résultat du parsing de classes — structure interne.
 * `className` → `Set<methodName>`
 */
type ClassMethodMap = Map<string, Set<string>>;

/**
 * Parse ligne par ligne pour extraire la carte des méthodes par classe.
 *
 * Suit la profondeur des accolades pour déterminer quand on sort d'une classe.
 * Ne gère pas les classes imbriquées (cas rare, accepté comme limitation).
 */
function extractClassMethods(lines: string[]): ClassMethodMap {
  const result: ClassMethodMap = new Map();
  let currentClass: string | null = null;
  let braceDepth = 0;
  let classEntryDepth = -1;

  for (const line of lines) {
    // Détecter une déclaration de classe
    const classMatch = line.match(
      /^\s{0,4}(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/,
    );
    if (classMatch && classMatch[1]) {
      currentClass = classMatch[1];
      classEntryDepth = braceDepth;
      if (!result.has(currentClass)) result.set(currentClass, new Set());
    }

    // Compter les accolades pour suivre la portée
    for (const ch of line) {
      if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        braceDepth--;
        // Si on sort de la profondeur d'entrée de la classe → fin de classe
        if (currentClass !== null && braceDepth <= classEntryDepth) {
          currentClass = null;
          classEntryDepth = -1;
        }
      }
    }

    // Détecter les méthodes dans la classe courante
    // (indentation > 0, suivi de `name(` avec modificateurs optionnels)
    if (currentClass !== null) {
      const methodMatch = line.match(
        /^\s{2,}(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/,
      );
      if (methodMatch && methodMatch[1]) {
        const methodName = methodMatch[1];
        if (!KEYWORDS.has(methodName) && methodName !== "constructor") {
          result.get(currentClass)!.add(methodName);
        }
      }
    }
  }

  return result;
}

/**
 * Détecte les déplacements de méthode entre classes.
 *
 * Pour chaque méthode présente dans une classe `C` de base :
 * - Si la méthode a disparu de `C` dans branch ET est apparue dans `D` (D ≠ C) :
 *   → move-method(method, C → D).
 */
function detectMoveMethod(
  baseLines: string[],
  branchLines: string[],
  max: number,
): Refactoring[] {
  const baseClasses = extractClassMethods(baseLines);
  const branchClasses = extractClassMethods(branchLines);

  // Au moins deux classes dans base pour qu'un move soit possible
  if (baseClasses.size === 0 || branchClasses.size === 0) return [];

  const results: Refactoring[] = [];

  for (const [sourceClass, baseMethods] of baseClasses) {
    for (const method of baseMethods) {
      if (results.length >= max) break;

      // La méthode doit avoir disparu de sa classe d'origine dans branch
      const stillHere = branchClasses.get(sourceClass)?.has(method) ?? false;
      if (stillHere) continue;

      // Chercher dans quelle autre classe elle est apparue
      for (const [targetClass, targetMethods] of branchClasses) {
        if (targetClass === sourceClass) continue;
        if (targetMethods.has(method)) {
          results.push({
            kind: "move-method",
            oldName: method,
            sourceClass,
            targetClass,
          });
          break;
        }
      }
    }
  }

  return results;
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Détecte les refactorings entre la version de base d'un fichier et une branche.
 *
 * Point d'entrée principal du module. Appelé deux fois par l'orchestrateur
 * RefMerge — une fois pour `(base, ours)`, une fois pour `(base, theirs)`.
 *
 * @param baseLines       Lignes du fichier dans la version de base (ancêtre commun)
 * @param branchLines     Lignes du fichier dans la branche (ours ou theirs)
 * @param maxRefactorings Quota maximum de refactorings retournés (défaut: 10)
 * @returns               Liste des refactorings détectés, triée par type de confiance
 *                        (rename-top-level > rename-local > move-method).
 *                        Retourne `[]` en cas d'erreur ou si aucun refactoring détecté.
 *
 * @example
 * ```ts
 * const refs = detectRefactorings(
 *   ["function foo(x) { return x + 1; }"],
 *   ["function foo(value) { return value + 1; }"],
 * );
 * // refs = [{ kind: "rename-local", oldName: "x", newName: "value", scope: "foo" }]
 * ```
 */
export function detectRefactorings(
  baseLines: string[],
  branchLines: string[],
  maxRefactorings = 10,
): Refactoring[] {
  try {
    if (baseLines.length === 0 || branchLines.length === 0) return [];
    // Cas trivial : contenus identiques — aucun refactoring
    if (arraysEqual(baseLines, branchLines)) return [];

    const results: Refactoring[] = [];

    // 1. Renames (rename-local + rename-top-level) — priorité haute
    const renames = detectRenames(baseLines, branchLines, maxRefactorings);
    results.push(...renames);

    // 2. Move-method — uniquement si quota non épuisé
    if (results.length < maxRefactorings) {
      const moves = detectMoveMethod(
        baseLines,
        branchLines,
        maxRefactorings - results.length,
      );
      results.push(...moves);
    }

    return results;
  } catch {
    // Dégradation silencieuse — jamais crasher l'orchestrateur
    return [];
  }
}
