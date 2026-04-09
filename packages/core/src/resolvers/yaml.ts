/**
 * GitWand — Résolveur YAML structurel
 *
 * Résout les conflits dans les fichiers YAML (.yaml / .yml) en analysant
 * la structure indentée et en fusionnant clé par clé, similaire au résolveur JSON.
 *
 * Implémenté sans dépendance externe — parsing structurel basé sur l'indentation.
 *
 * Stratégie :
 *  1. Parser chaque version en "entrées" hiérarchiques (clé + contenu indenté)
 *  2. Pour chaque clé au même niveau :
 *      - Ajoutée d'un seul côté → accepter
 *      - Supprimée d'un seul côté, l'autre intact → supprimer
 *      - Modifiée des deux côtés de façon identique → accepter
 *      - Modifiée d'un seul côté → accepter la modification
 *      - Modifiée des deux côtés différemment → conflit non résolvable
 *  3. Pour les valeurs scalaires strictement identiques → garder
 *  4. Pour les blocs imbriqués → récursion
 *
 * Limites (cas non gérés → fallback textuel) :
 *  - Anchors et aliases YAML (&anchor / *alias)
 *  - Multi-line strings (| et > block scalars)
 *  - Séquences (listes avec -) : fusion conservatrice (union si disjoint, sinon conflit)
 *  - Flow mappings/sequences inline ({ } / [ ])
 */

// ─── Types internes ───────────────────────────────────────

/**
 * Une entrée YAML parsée.
 * Peut représenter :
 *   - key: value  (scalaire)
 *   - key:         (début d'objet indenté)
 *   - - item       (élément de liste)
 *   - # commentaire ou ligne vide
 */
export interface YamlEntry {
  /** Indentation en espaces */
  indent: number;
  /** Clé de l'entrée, ou null pour les lignes non-clé (commentaires, listes) */
  key: string | null;
  /** Valeur scalaire sur la même ligne que la clé, ou null si objet/liste */
  scalar: string | null;
  /** Lignes brutes constituant cette entrée (clé + contenu indenté suivant) */
  rawLines: string[];
}

// ─── Parser structurel ────────────────────────────────────

const RE_KEY_VALUE = /^(\s*)([\w.-][\w.\- ]*?):\s+(.+)$/;
const RE_KEY_ONLY  = /^(\s*)([\w.-][\w.\- ]*?):\s*$/;
const RE_LIST_ITEM = /^(\s*)-\s/;
const RE_COMMENT   = /^\s*#/;
const RE_ANCHOR    = /[&*]/;

/**
 * Détecte si un bloc YAML contient des constructions non gérées (anchors, block scalars).
 */
function hasUnsupportedConstruct(lines: string[]): boolean {
  return lines.some(
    (l) =>
      RE_ANCHOR.test(l) ||
      /:\s*[|>]/.test(l) ||   // block scalar
      /^\s*[|>]/.test(l),
  );
}

/**
 * Détecte le niveau d'indentation de base (indentation minimale des lignes non vides).
 */
function baseIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === "" || RE_COMMENT.test(l)) continue;
    const m = l.match(/^(\s*)/);
    if (m && m[1].length < min) min = m[1].length;
  }
  return min === Infinity ? 0 : min;
}

/**
 * Groupe les lignes en entrées au niveau d'indentation `rootIndent`.
 * Chaque entrée commence par une ligne à `rootIndent` et absorbe
 * toutes les lignes suivantes avec une indentation strictement supérieure.
 */
function groupEntries(lines: string[], rootIndent: number): YamlEntry[] {
  const entries: YamlEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Lignes vides et commentaires : entrée sans clé
    if (line.trim() === "" || RE_COMMENT.test(line)) {
      entries.push({ indent: rootIndent, key: null, scalar: null, rawLines: [line] });
      i++;
      continue;
    }

    const m = line.match(/^(\s*)/);
    const indent = m ? m[1].length : 0;

    // Ligne d'un niveau plus profond que rootIndent : appartient à l'entrée précédente
    if (indent > rootIndent && entries.length > 0) {
      entries[entries.length - 1].rawLines.push(line);
      i++;
      continue;
    }

    // Nouvelle entrée au niveau rootIndent
    const keyValue = line.match(RE_KEY_VALUE);
    const keyOnly  = line.match(RE_KEY_ONLY);
    const listItem = RE_LIST_ITEM.test(line);

    if (keyValue) {
      entries.push({
        indent,
        key: keyValue[2].trim(),
        scalar: keyValue[3].trim(),
        rawLines: [line],
      });
    } else if (keyOnly) {
      entries.push({
        indent,
        key: keyOnly[2].trim(),
        scalar: null,
        rawLines: [line],
      });
    } else if (listItem) {
      entries.push({ indent, key: null, scalar: null, rawLines: [line] });
    } else {
      entries.push({ indent, key: null, scalar: null, rawLines: [line] });
    }
    i++;
  }

  return entries;
}

// ─── Merge engine ─────────────────────────────────────────

/** Résultat du merge YAML */
export interface YamlMergeResult {
  /** Lignes fusionnées (null = conflit non résolvable) */
  mergedLines: string[] | null;
  /** Description de la fusion */
  reason: string;
  /** Clés résolues automatiquement */
  resolvedKeys: number;
  /** Clés en conflit */
  unresolvedKeys: number;
}

/**
 * Compare deux tableaux de strings pour égalité.
 */
function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/**
 * Fusionne deux séquences YAML (listes `-`).
 * Stratégie : union des éléments (éléments de ours + éléments de theirs absents de ours).
 * Retourne null si les listes sont divergentes de façon non triviale.
 */
function mergeSequences(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): string[] | null {
  // Si ours et theirs sont identiques → garder
  if (linesEqual(oursLines, theirsLines)) return [...oursLines];
  // Si ours = base → prendre theirs
  if (linesEqual(oursLines, baseLines)) return [...theirsLines];
  // Si theirs = base → prendre ours
  if (linesEqual(theirsLines, baseLines)) return [...oursLines];
  // Les deux ont modifié → union simple des lignes uniques
  // (conservative : ne pas réordonner, ajouter les nouvelles lignes de theirs à la fin de ours)
  const oursSet = new Set(oursLines.map((l) => l.trim()));
  const extra = theirsLines.filter((l) => !oursSet.has(l.trim()));
  if (extra.length > 0) {
    return [...oursLines, ...extra];
  }
  // theirs est un sous-ensemble de ours (ou identique) → garder ours
  return [...oursLines];
}

/**
 * Fusionne récursivement deux blocs YAML structurés.
 * Retourne les lignes fusionnées ou null si un conflit non résolvable est détecté.
 */
function mergeYamlBlocks(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): { lines: string[] | null; resolvedKeys: number; unresolvedKeys: number } {
  // Cas triviaux
  if (linesEqual(oursLines, theirsLines)) {
    return { lines: [...oursLines], resolvedKeys: 1, unresolvedKeys: 0 };
  }
  if (linesEqual(oursLines, baseLines)) {
    return { lines: [...theirsLines], resolvedKeys: 1, unresolvedKeys: 0 };
  }
  if (linesEqual(theirsLines, baseLines)) {
    return { lines: [...oursLines], resolvedKeys: 1, unresolvedKeys: 0 };
  }

  // Déterminer l'indentation de base
  const ri = baseIndent([...oursLines, ...theirsLines, ...baseLines]);

  // Grouper en entrées
  const baseEntries = groupEntries(baseLines, ri);
  const oursEntries = groupEntries(oursLines, ri);
  const theirsEntries = groupEntries(theirsLines, ri);

  // Index par clé
  const baseMap  = new Map<string, YamlEntry>();
  const oursMap  = new Map<string, YamlEntry>();
  const theirsMap = new Map<string, YamlEntry>();

  for (const e of baseEntries)  if (e.key) baseMap.set(e.key, e);
  for (const e of oursEntries)  if (e.key) oursMap.set(e.key, e);
  for (const e of theirsEntries) if (e.key) theirsMap.set(e.key, e);

  // Ordre des clés : ours first, puis nouvelles clés de theirs
  const oursOrder  = oursEntries.filter((e) => e.key).map((e) => e.key as string);
  const theirsKeys = theirsEntries.filter((e) => e.key).map((e) => e.key as string);
  const allKeys: string[] = [...oursOrder];
  for (const k of theirsKeys) {
    if (!allKeys.includes(k)) allKeys.push(k);
  }

  const resultLines: string[] = [];
  let resolvedKeys = 0;
  let unresolvedKeys = 0;

  // Conserver les lignes non-clé (commentaires, vides) de ours en tête
  for (const e of oursEntries) {
    if (!e.key) resultLines.push(...e.rawLines);
    else break;
  }

  for (const key of allKeys) {
    const base  = baseMap.get(key);
    const ours  = oursMap.get(key);
    const theirs = theirsMap.get(key);

    // Clé absente de base → ajout d'un ou des deux côtés
    if (!base) {
      if (ours && theirs) {
        if (linesEqual(ours.rawLines, theirs.rawLines)) {
          // Même ajout des deux côtés
          resultLines.push(...ours.rawLines);
          resolvedKeys++;
        } else {
          // Ajout conflictuel → non résolvable
          unresolvedKeys++;
          return { lines: null, resolvedKeys, unresolvedKeys };
        }
      } else if (ours) {
        resultLines.push(...ours.rawLines);
        resolvedKeys++;
      } else if (theirs) {
        resultLines.push(...theirs.rawLines);
        resolvedKeys++;
      }
      continue;
    }

    // Clé dans base → peut avoir été modifiée/supprimée
    const oursChanged   = ours   ? !linesEqual(base.rawLines, ours.rawLines)   : true; // absent = supprimé
    const theirsChanged = theirs ? !linesEqual(base.rawLines, theirs.rawLines) : true;

    if (!ours && !theirs) {
      // Supprimée des deux côtés → supprimer
      resolvedKeys++;
      continue;
    }

    if (!ours && theirs) {
      if (!theirsChanged) {
        // Ours supprimé, theirs intact → supprimer
        resolvedKeys++;
      } else {
        // Ours supprimé, theirs modifié → conflit
        unresolvedKeys++;
        return { lines: null, resolvedKeys, unresolvedKeys };
      }
      continue;
    }

    if (ours && !theirs) {
      if (!oursChanged) {
        // Theirs supprimé, ours intact → supprimer
        resolvedKeys++;
      } else {
        // Theirs supprimé, ours modifié → conflit
        unresolvedKeys++;
        return { lines: null, resolvedKeys, unresolvedKeys };
      }
      continue;
    }

    // Ours et theirs présents
    if (!oursChanged && !theirsChanged) {
      // Aucun côté n'a changé → garder base
      resultLines.push(...base.rawLines);
      resolvedKeys++;
    } else if (linesEqual(ours!.rawLines, theirs!.rawLines)) {
      // Same change des deux côtés
      resultLines.push(...ours!.rawLines);
      resolvedKeys++;
    } else if (!oursChanged) {
      // Seul theirs a changé
      resultLines.push(...theirs!.rawLines);
      resolvedKeys++;
    } else if (!theirsChanged) {
      // Seul ours a changé
      resultLines.push(...ours!.rawLines);
      resolvedKeys++;
    } else {
      // Les deux ont changé différemment
      // Tenter récursion si la clé est un objet indenté (ours.scalar === null)
      if (ours!.scalar === null && theirs!.scalar === null) {
        // Les deux ont un sous-bloc → récursion sur le contenu indenté
        const oursContent  = ours!.rawLines.slice(1);  // sans la ligne-clé
        const theirsContent = theirs!.rawLines.slice(1);
        const baseContent  = base.rawLines.slice(1);

        const sub = mergeYamlBlocks(baseContent, oursContent, theirsContent);
        if (sub.lines !== null) {
          resultLines.push(ours!.rawLines[0]); // ligne-clé de ours
          resultLines.push(...sub.lines);
          resolvedKeys += sub.resolvedKeys;
          unresolvedKeys += sub.unresolvedKeys;
        } else {
          unresolvedKeys++;
          return { lines: null, resolvedKeys, unresolvedKeys };
        }
      } else if (ours!.scalar !== null && theirs!.scalar !== null) {
        // Séquences imbriquées ?
        const allList = [...ours!.rawLines, ...theirs!.rawLines, ...base.rawLines]
          .every((l) => RE_LIST_ITEM.test(l) || l.trim() === "" || RE_COMMENT.test(l));

        if (allList) {
          const merged = mergeSequences(base.rawLines, ours!.rawLines, theirs!.rawLines);
          if (merged) {
            resultLines.push(...merged);
            resolvedKeys++;
          } else {
            unresolvedKeys++;
            return { lines: null, resolvedKeys, unresolvedKeys };
          }
        } else {
          // Scalaires différents → conflit non résolvable
          unresolvedKeys++;
          return { lines: null, resolvedKeys, unresolvedKeys };
        }
      } else {
        // Type de valeur différent → conflit
        unresolvedKeys++;
        return { lines: null, resolvedKeys, unresolvedKeys };
      }
    }
  }

  return { lines: resultLines, resolvedKeys, unresolvedKeys };
}

// ─── Public API ───────────────────────────────────────────

/**
 * Tente de résoudre un conflit YAML en fusionnant structurellement
 * les trois versions.
 *
 * @param baseLines   - Lignes de la version base
 * @param oursLines   - Lignes de la version ours
 * @param theirsLines - Lignes de la version theirs
 * @returns `YamlMergeResult` avec `mergedLines !== null` si résolu, `null` sinon
 */
export function tryResolveYamlConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): YamlMergeResult {
  // Rejeter les constructions non supportées
  if (
    hasUnsupportedConstruct(oursLines) ||
    hasUnsupportedConstruct(theirsLines)
  ) {
    return {
      mergedLines: null,
      reason: "YAML contient des anchors, aliases ou block scalars — fusion structurelle non supportée (fallback textuel).",
      resolvedKeys: 0,
      unresolvedKeys: 1,
    };
  }

  const { lines, resolvedKeys, unresolvedKeys } = mergeYamlBlocks(
    baseLines,
    oursLines,
    theirsLines,
  );

  if (lines === null) {
    return {
      mergedLines: null,
      reason: `Fusion YAML impossible : ${unresolvedKeys} clé(s) en conflit non résolvable.`,
      resolvedKeys,
      unresolvedKeys,
    };
  }

  return {
    mergedLines: lines,
    reason: `Fusion YAML structurelle réussie : ${resolvedKeys} clé(s) fusionnée(s).`,
    resolvedKeys,
    unresolvedKeys,
  };
}
