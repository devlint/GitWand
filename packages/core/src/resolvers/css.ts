/**
 * GitWand — Résolveur CSS/SCSS/Less
 *
 * Résout les conflits dans les fichiers CSS, SCSS et Less en analysant
 * la structure des règles (sélecteur + bloc de propriétés) et en fusionnant
 * règle par règle.
 *
 * Stratégie :
 *  1. Parser les trois versions en "règles" CSS : sélecteur + propriétés
 *  2. Pour chaque règle :
 *      - Absente de base → ajout (accepter)
 *      - Modifiée d'un seul côté → accepter la modification
 *      - Same change → accepter
 *      - Modifiée des deux côtés → tenter une fusion propriété par propriété
 *      - Conflit réel → fallback textuel (null)
 *  3. Reconnaître aussi les at-rules (@media, @keyframes, @import, etc.)
 *
 * Limites :
 *  - Les sélecteurs imbriqués SCSS (`.parent { .child { } }`) ne sont pas
 *    récursivement fusionnés (traités comme blocs opaques)
 *  - Les at-rules avec blocs (@media) : fusion conservative sur le bloc complet
 *  - Les variables CSS (--var: value) et SCSS ($var: value) : traitées comme propriétés
 */

// ─── Types internes ───────────────────────────────────────

/** Une règle CSS parsée */
export interface CssRule {
  /** Sélecteur ou at-rule (ex: `.btn`, `@media (max-width: 768px)`) */
  selector: string;
  /** Propriétés : tableau de lignes brutes entre `{` et `}` */
  properties: string[];
  /** Lignes brutes constituant la règle complète */
  rawLines: string[];
  /** Commentaires/blancs précédant la règle */
  leadingComments: string[];
  /** Type de règle */
  kind: "rule" | "at-rule" | "comment" | "blank" | "import";
}

// ─── Parser CSS ───────────────────────────────────────────

const RE_SELECTOR_OPEN = /^([^{]+)\{$/;
const RE_AT_IMPORT     = /^@import\s+/;
const RE_CLOSE_BRACE   = /^\}\s*$/;
const RE_PROPERTY      = /^[\w$\-\-]+[^:]*:\s*.+;?\s*$/;
const RE_COMMENT_LINE  = /^\s*\/[*/]/;
const RE_BLANK         = /^\s*$/;

/**
 * Parse un tableau de lignes CSS en règles structurées.
 */
export function parseCssRules(lines: string[]): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Lignes vides
    if (RE_BLANK.test(line)) {
      rules.push({
        selector: "",
        properties: [],
        rawLines: [lines[i]],
        leadingComments: [],
        kind: "blank",
      });
      i++;
      continue;
    }

    // Commentaires sur une ligne (// ou /* ... */)
    if (RE_COMMENT_LINE.test(line)) {
      const commentLines: string[] = [];
      // Absorber les lignes de commentaire consécutives
      while (i < lines.length && (RE_COMMENT_LINE.test(lines[i].trim()) || RE_BLANK.test(lines[i].trim()))) {
        commentLines.push(lines[i]);
        i++;
      }
      rules.push({
        selector: "",
        properties: [],
        rawLines: commentLines,
        leadingComments: commentLines,
        kind: "comment",
      });
      continue;
    }

    // @import (inline, pas de bloc)
    if (RE_AT_IMPORT.test(line)) {
      rules.push({
        selector: line,
        properties: [],
        rawLines: [lines[i]],
        leadingComments: [],
        kind: "import",
      });
      i++;
      continue;
    }

    // Règle avec bloc { }
    const openMatch = line.match(RE_SELECTOR_OPEN);
    if (openMatch) {
      const selector = openMatch[1].trim();
      const rawLines = [lines[i]];
      const properties: string[] = [];
      i++;

      let depth = 1;
      while (i < lines.length && depth > 0) {
        const inner = lines[i];
        const trimmed = inner.trim();
        rawLines.push(inner);

        if (trimmed.endsWith("{")) depth++;
        else if (RE_CLOSE_BRACE.test(trimmed)) depth--;

        if (depth > 0) properties.push(inner);
        i++;
      }

      const isAtRule = selector.startsWith("@");
      rules.push({
        selector,
        properties,
        rawLines,
        leadingComments: [],
        kind: isAtRule ? "at-rule" : "rule",
      });
      continue;
    }

    // Ligne orpheline (propriété hors bloc, variable, etc.)
    rules.push({
      selector: line,
      properties: [],
      rawLines: [lines[i]],
      leadingComments: [],
      kind: "rule",
    });
    i++;
  }

  return rules;
}

// ─── Merge engine ─────────────────────────────────────────

/** Résultat du merge CSS */
export interface CssMergeResult {
  /** Lignes fusionnées (null = conflit non résolvable) */
  mergedLines: string[] | null;
  /** Description de la fusion */
  reason: string;
  /** Règles résolues automatiquement */
  resolvedRules: number;
  /** Règles en conflit */
  unresolvedRules: number;
}

/**
 * Compare deux tableaux de strings pour égalité.
 */
function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/**
 * Vérifie qu'un tableau de lignes de propriétés contient uniquement des
 * déclarations CSS valides (prop: value) ou des commentaires/blancs/règles imbriquées.
 * Retourne false uniquement si une ligne n'est ni une déclaration, ni un commentaire,
 * ni une règle imbriquée (un bloc SCSS `selector { ... }`).
 */
function hasValidCssProperties(propLines: string[]): boolean {
  let depth = 0;
  for (const line of propLines) {
    const t = line.trim();
    if (!t || RE_COMMENT_LINE.test(t) || RE_BLANK.test(t)) continue;
    if (t.endsWith("{")) { depth++; continue; }
    if (t === "}") { depth--; continue; }
    if (depth > 0) continue; // Inside a nested block — accepted
    if (!t.includes(":")) return false;
  }
  return true;
}

// ─── SCSS one-level nesting (v1.4) ───────────────────────────

interface NestedBlock {
  selector: string;
  innerLines: string[]; // lines between { and }
  rawLines: string[];   // full raw representation
  indent: string;
}

/**
 * Vérifie si un bloc de propriétés contient des sélecteurs imbriqués (SCSS).
 */
function hasNestedSelectors(propLines: string[]): boolean {
  return propLines.some((l) => {
    const t = l.trim();
    return t.endsWith("{") && !t.startsWith("@") && !t.includes(":");
  });
}

/**
 * Découpe les lignes de propriétés en déclarations plates et blocs imbriqués.
 * Supporte un seul niveau de nesting.
 */
function splitProperties(propLines: string[]): {
  flatDecls: string[];
  nested: Map<string, NestedBlock>;
} {
  const flatDecls: string[] = [];
  const nested = new Map<string, NestedBlock>();
  let i = 0;

  while (i < propLines.length) {
    const line = propLines[i];
    const t = line.trim();
    const indent = line.match(/^(\s*)/)?.[1] ?? "";

    // Nested selector block: `  .child {`
    if (t.endsWith("{") && !t.startsWith("@") && !t.includes(":")) {
      const selector = t.slice(0, -1).trim();
      const rawLines: string[] = [line];
      const innerLines: string[] = [];
      i++;
      let depth = 1;
      while (i < propLines.length && depth > 0) {
        const inner = propLines[i];
        rawLines.push(inner);
        const it = inner.trim();
        if (it.endsWith("{")) depth++;
        else if (it === "}") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        if (depth > 0) innerLines.push(inner);
        i++;
      }
      nested.set(selector, { selector, innerLines, rawLines, indent });
      continue;
    }

    if (t) flatDecls.push(line);
    i++;
  }

  return { flatDecls, nested };
}

/**
 * Fusionne les propriétés CSS avec support pour les sélecteurs imbriqués SCSS (un niveau).
 * Si aucun sélecteur imbriqué n'est détecté, délègue à `mergeCssProperties`.
 */
function mergeWithNestedSelectors(
  base: string[],
  ours: string[],
  theirs: string[],
): string[] | null {
  if (!hasNestedSelectors(ours) && !hasNestedSelectors(theirs)) {
    return mergeCssProperties(base, ours, theirs);
  }

  const { flatDecls: baseFlat, nested: baseNested } = splitProperties(base);
  const { flatDecls: oursFlat, nested: oursNested }   = splitProperties(ours);
  const { flatDecls: theirsFlat, nested: theirsNested } = splitProperties(theirs);

  // Merge flat declarations
  const mergedFlat = mergeCssProperties(baseFlat, oursFlat, theirsFlat);
  if (mergedFlat === null) return null;

  // Merge nested blocks by selector (union)
  const mergedNested: string[] = [];
  const seen = new Set<string>();

  for (const [sel, oursBlock] of oursNested) {
    seen.add(sel);
    const theirsBlock = theirsNested.get(sel);
    const baseBlock   = baseNested.get(sel);

    if (!theirsBlock) {
      mergedNested.push(...oursBlock.rawLines);
      continue;
    }

    // Both sides have this nested selector
    if (linesEqual(oursBlock.innerLines, theirsBlock.innerLines)) {
      mergedNested.push(...oursBlock.rawLines);
      continue;
    }

    // Try to merge the nested block's properties
    const mergedInner = mergeCssProperties(
      baseBlock?.innerLines ?? [],
      oursBlock.innerLines,
      theirsBlock.innerLines,
    );
    if (mergedInner === null) return null;

    const ind = oursBlock.indent;
    mergedNested.push(`${ind}${sel} {`);
    mergedNested.push(...mergedInner);
    mergedNested.push(`${ind}}`);
  }

  // Nested selectors only in theirs
  for (const [sel, theirsBlock] of theirsNested) {
    if (!seen.has(sel)) {
      mergedNested.push(...theirsBlock.rawLines);
    }
  }

  return [...mergedFlat, ...mergedNested];
}

/**
 * Fusionne deux blocs de propriétés CSS du même sélecteur.
 * Stratégie : union des propriétés. Si une propriété est modifiée des deux côtés
 * avec des valeurs différentes → conflit non résolvable.
 *
 * Retourne null si les propriétés ne sont pas du CSS valide (pas de `:` dans les lignes).
 */
function mergeCssProperties(
  base: string[],
  ours: string[],
  theirs: string[],
): string[] | null {
  // Validation : rejeter si les propriétés ne ressemblent pas à du CSS
  if (!hasValidCssProperties(ours) || !hasValidCssProperties(theirs)) {
    return null;
  }

  // Parser les propriétés en Map { prop -> value }
  function parseProps(propLines: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of propLines) {
      const t = line.trim();
      if (!t || RE_COMMENT_LINE.test(t) || RE_BLANK.test(t)) continue;
      const colon = t.indexOf(":");
      if (colon === -1) continue;
      const prop = t.slice(0, colon).trim();
      const val  = t.slice(colon + 1).trim().replace(/;$/, "").trim();
      map.set(prop, val);
    }
    return map;
  }

  // Détecter l'indentation du bloc
  const indent = (ours.find((l) => l.trim() && !RE_COMMENT_LINE.test(l.trim())) ?? "  ").match(/^(\s*)/)?.[1] ?? "  ";

  const baseMap  = parseProps(base);
  const oursMap  = parseProps(ours);
  const theirsMap = parseProps(theirs);

  // Toutes les propriétés
  const allProps = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const result: string[] = [];

  for (const prop of allProps) {
    const baseVal  = baseMap.get(prop);
    const oursVal  = oursMap.get(prop);
    const theirsVal = theirsMap.get(prop);

    // Absent de base → ajout
    if (baseVal === undefined) {
      if (oursVal !== undefined && theirsVal !== undefined) {
        if (oursVal === theirsVal) {
          result.push(`${indent}${prop}: ${oursVal};`);
        } else {
          return null; // Conflit
        }
      } else if (oursVal !== undefined) {
        result.push(`${indent}${prop}: ${oursVal};`);
      } else if (theirsVal !== undefined) {
        result.push(`${indent}${prop}: ${theirsVal};`);
      }
      continue;
    }

    // Présent dans base
    const oursChanged   = oursVal   !== undefined ? oursVal   !== baseVal : true;
    const theirsChanged = theirsVal !== undefined ? theirsVal !== baseVal : true;

    if (!oursChanged && !theirsChanged) {
      result.push(`${indent}${prop}: ${baseVal};`);
    } else if (oursVal === theirsVal) {
      result.push(`${indent}${prop}: ${oursVal};`);
    } else if (!oursChanged) {
      result.push(`${indent}${prop}: ${theirsVal};`);
    } else if (!theirsChanged) {
      result.push(`${indent}${prop}: ${oursVal};`);
    } else if (oursVal === undefined) {
      if (!theirsChanged) {
        // Ours supprimé, theirs inchangé → supprimer
      } else {
        return null; // Ours supprimé, theirs modifié
      }
    } else if (theirsVal === undefined) {
      if (!oursChanged) {
        // Theirs supprimé, ours inchangé → supprimer
      } else {
        return null; // Theirs supprimé, ours modifié
      }
    } else {
      return null; // Valeurs différentes des deux côtés
    }
  }

  return result;
}

/**
 * Tente de résoudre un conflit CSS/SCSS en fusionnant règle par règle.
 *
 * @param baseLines   - Lignes de la version base
 * @param oursLines   - Lignes de la version ours
 * @param theirsLines - Lignes de la version theirs
 */
export function tryResolveCssConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): CssMergeResult {
  const baseRules   = parseCssRules(baseLines);
  const oursRules   = parseCssRules(oursLines);
  const theirsRules = parseCssRules(theirsLines);

  // Filtrer les règles significatives (pas blank/comment) pour l'index
  const baseMap   = new Map<string, CssRule>();
  const oursMap   = new Map<string, CssRule>();
  const theirsMap = new Map<string, CssRule>();

  for (const r of baseRules)   if (r.selector) baseMap.set(r.selector, r);
  for (const r of oursRules)   if (r.selector) oursMap.set(r.selector, r);
  for (const r of theirsRules) if (r.selector) theirsMap.set(r.selector, r);

  // Ordre : ours d'abord, puis nouvelles règles de theirs
  const oursOrder   = oursRules.map((r) => r.selector).filter(Boolean);
  const theirsOrder = theirsRules.map((r) => r.selector).filter(Boolean);
  const allKeys = [...oursOrder];
  for (const k of theirsOrder) {
    if (!allKeys.includes(k)) allKeys.push(k);
  }

  // Inclure aussi les blancs et commentaires de ours dans le résultat
  const resultLines: string[] = [];
  let resolvedRules = 0;
  let unresolvedRules = 0;

  // Ajouter les blancs/commentaires de ours qui précèdent les règles
  for (const rule of oursRules) {
    if (rule.kind === "blank" || rule.kind === "comment") {
      resultLines.push(...rule.rawLines);
    } else {
      break;
    }
  }

  for (const selector of allKeys) {
    if (!selector) continue;

    const base  = baseMap.get(selector);
    const ours  = oursMap.get(selector);
    const theirs = theirsMap.get(selector);

    if (!ours && !theirs) continue;

    // Absent de base → ajout
    if (!base) {
      if (ours && theirs) {
        if (linesEqual(ours.rawLines, theirs.rawLines)) {
          resultLines.push(...ours.rawLines);
          resolvedRules++;
        } else if (ours.kind === "rule" && theirs.kind === "rule") {
          // Tenter fusion des propriétés (avec support SCSS one-level nesting)
          const merged = mergeWithNestedSelectors([], ours.properties, theirs.properties);
          if (merged !== null) {
            const indent = ours.rawLines[0].match(/^(\s*)/)?.[1] ?? "";
            resultLines.push(`${indent}${selector} {`);
            resultLines.push(...merged);
            resultLines.push(`${indent}}`);
            resolvedRules++;
          } else {
            unresolvedRules++;
            return {
              mergedLines: null,
              reason: `Conflit CSS sur le sélecteur '${selector}' — propriétés incompatibles.`,
              resolvedRules,
              unresolvedRules,
            };
          }
        } else {
          unresolvedRules++;
          return {
            mergedLines: null,
            reason: `Conflit CSS sur '${selector}' — ajouté différemment des deux côtés.`,
            resolvedRules,
            unresolvedRules,
          };
        }
      } else if (ours) {
        resultLines.push(...ours.rawLines);
        resolvedRules++;
      } else if (theirs) {
        resultLines.push(...theirs.rawLines);
        resolvedRules++;
      }
      continue;
    }

    const oursChanged   = ours   ? !linesEqual(base.rawLines, ours.rawLines)   : true;
    const theirsChanged = theirs ? !linesEqual(base.rawLines, theirs.rawLines) : true;

    if (!ours && !theirs) {
      resolvedRules++;
      continue;
    }

    if (!ours) {
      if (!theirsChanged) {
        resolvedRules++;
      } else {
        unresolvedRules++;
        return { mergedLines: null, reason: `Conflit CSS sur '${selector}' — ours supprimé, theirs modifié.`, resolvedRules, unresolvedRules };
      }
      continue;
    }

    if (!theirs) {
      if (!oursChanged) {
        resolvedRules++;
      } else {
        unresolvedRules++;
        return { mergedLines: null, reason: `Conflit CSS sur '${selector}' — theirs supprimé, ours modifié.`, resolvedRules, unresolvedRules };
      }
      continue;
    }

    if (!oursChanged && !theirsChanged) {
      resultLines.push(...base.rawLines);
      resolvedRules++;
    } else if (linesEqual(ours.rawLines, theirs.rawLines)) {
      resultLines.push(...ours.rawLines);
      resolvedRules++;
    } else if (!oursChanged) {
      resultLines.push(...theirs.rawLines);
      resolvedRules++;
    } else if (!theirsChanged) {
      resultLines.push(...ours.rawLines);
      resolvedRules++;
    } else if (ours.kind === "rule" && theirs.kind === "rule") {
      // Les deux ont modifié le même sélecteur → fusion des propriétés (avec SCSS one-level nesting)
      const merged = mergeWithNestedSelectors(base.properties, ours.properties, theirs.properties);
      if (merged !== null) {
        const indent = ours.rawLines[0].match(/^(\s*)/)?.[1] ?? "";
        resultLines.push(`${indent}${selector} {`);
        resultLines.push(...merged);
        resultLines.push(`${indent}}`);
        resolvedRules++;
      } else {
        unresolvedRules++;
        return {
          mergedLines: null,
          reason: `Conflit CSS sur le sélecteur '${selector}' — propriétés modifiées incompatibles.`,
          resolvedRules,
          unresolvedRules,
        };
      }
    } else {
      unresolvedRules++;
      return {
        mergedLines: null,
        reason: `Conflit CSS sur '${selector}' — at-rules modifiées des deux côtés.`,
        resolvedRules,
        unresolvedRules,
      };
    }
  }

  return {
    mergedLines: resultLines,
    reason: `Fusion CSS réussie : ${resolvedRules} règle(s) fusionnée(s).`,
    resolvedRules,
    unresolvedRules,
  };
}
