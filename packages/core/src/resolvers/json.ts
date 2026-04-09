/**
 * GitWand — Résolveur JSON/JSONC sémantique
 *
 * Résout les conflits dans les fichiers JSON et JSONC en parsant
 * les trois versions (base, ours, theirs) et en effectuant une
 * fusion au niveau des clés plutôt que des lignes.
 *
 * Stratégie :
 *  1. Tenter de parser les trois versions comme JSON (strip de commentaires JSONC)
 *  2. Calculer les deltas clé-par-clé (récursif sur les objets)
 *  3. Si tous les conflits de clés sont trivialement résolvables → merge
 *  4. Sinon → retourner null (fallback textuel dans resolver.ts)
 *
 * Cas gérés :
 *  - Clé ajoutée des deux côtés avec valeurs différentes → conflit non résolvable
 *  - Clé ajoutée d'un seul côté → accepter l'ajout
 *  - Clé supprimée d'un seul côté, pas modifiée de l'autre → supprimer
 *  - Clé modifiée des deux côtés de la même façon → prendre la valeur
 *  - Clé modifiée des deux côtés différemment → conflit non résolvable
 *  - Merge récursif pour les objets imbriqués
 */

/** Résultat d'une fusion JSON */
export interface JsonMergeResult {
  /** Valeur fusionnée (null = conflit non résolvable) */
  merged: unknown | null;
  /** Description de la fusion effectuée */
  reason: string;
  /** Nombre de conflits résolus automatiquement */
  resolvedKeys: number;
  /** Nombre de conflits non résolvables */
  unresolvedKeys: number;
}

// ─── Strip JSONC comments ─────────────────────────────────

/**
 * Supprime les commentaires // et /* *\/ d'un fichier JSONC.
 * Assez robuste pour les cas courants (config files).
 */
export function stripJsoncComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    // Gestion des chaînes de caractères
    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        result += ch + next;
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      result += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    // Commentaire ligne // ...
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // Commentaire bloc /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2; // sauter */
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ─── JSON deep merge ──────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

/**
 * Vérifie si une valeur est un objet JSON (et pas null, ni tableau).
 */
function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Vérifie si deux valeurs JSON sont profondément égales.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, (b as JsonArray)[i]));
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => k in b && jsonEqual(a[k], (b as JsonObject)[k]));
  }
  return false;
}

/**
 * Fusionne récursivement deux objets JSON avec une base commune.
 *
 * Retourne `{ merged, resolvedKeys, unresolvedKeys }`.
 * Si `merged === null`, au moins un conflit est non résolvable.
 */
function mergeObjects(
  base: JsonObject,
  ours: JsonObject,
  theirs: JsonObject,
): { merged: JsonObject | null; resolvedKeys: number; unresolvedKeys: number } {
  const result: JsonObject = {};
  let resolvedKeys = 0;
  let unresolvedKeys = 0;

  // Ensemble de toutes les clés présentes dans au moins une version
  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  for (const key of allKeys) {
    const inBase = key in base;
    const inOurs = key in ours;
    const inTheirs = key in theirs;

    const baseVal = base[key];
    const oursVal = ours[key];
    const theirsVal = theirs[key];

    // Clé présente dans les deux branches, absente de la base → ajout des deux côtés
    if (!inBase && inOurs && inTheirs) {
      if (jsonEqual(oursVal, theirsVal)) {
        // Même valeur ajoutée des deux côtés → same_change
        result[key] = oursVal;
        resolvedKeys++;
      } else if (isObject(oursVal) && isObject(theirsVal)) {
        // Objets ajoutés différemment → fusion récursive depuis base vide
        const sub = mergeObjects({}, oursVal, theirsVal);
        if (sub.merged !== null) {
          result[key] = sub.merged;
          resolvedKeys += sub.resolvedKeys + 1;
          unresolvedKeys += sub.unresolvedKeys;
        } else {
          unresolvedKeys++;
          return { merged: null, resolvedKeys, unresolvedKeys };
        }
      } else {
        // Valeurs scalaires différentes → conflit non résolvable
        unresolvedKeys++;
        return { merged: null, resolvedKeys, unresolvedKeys };
      }
      continue;
    }

    // Clé dans base + ours, absent de theirs → theirs a supprimé
    if (inBase && inOurs && !inTheirs) {
      if (jsonEqual(baseVal, oursVal)) {
        // Ours n'a pas changé, theirs a supprimé → supprimer
        resolvedKeys++;
        // Ne pas ajouter à result (suppression)
      } else {
        // Ours a modifié, theirs a supprimé → conflit
        unresolvedKeys++;
        return { merged: null, resolvedKeys, unresolvedKeys };
      }
      continue;
    }

    // Clé dans base + theirs, absent de ours → ours a supprimé
    if (inBase && !inOurs && inTheirs) {
      if (jsonEqual(baseVal, theirsVal)) {
        // Theirs n'a pas changé, ours a supprimé → supprimer
        resolvedKeys++;
        // Ne pas ajouter à result
      } else {
        // Theirs a modifié, ours a supprimé → conflit
        unresolvedKeys++;
        return { merged: null, resolvedKeys, unresolvedKeys };
      }
      continue;
    }

    // Clé dans base seulement → supprimée des deux côtés
    if (inBase && !inOurs && !inTheirs) {
      resolvedKeys++;
      // Ne pas ajouter à result
      continue;
    }

    // Clé dans ours seulement (ajout ours)
    if (!inBase && inOurs && !inTheirs) {
      result[key] = oursVal;
      resolvedKeys++;
      continue;
    }

    // Clé dans theirs seulement (ajout theirs)
    if (!inBase && !inOurs && inTheirs) {
      result[key] = theirsVal;
      resolvedKeys++;
      continue;
    }

    // Clé présente partout → modifier éventuelle
    if (inBase && inOurs && inTheirs) {
      const oursChanged = !jsonEqual(baseVal, oursVal);
      const theirsChanged = !jsonEqual(baseVal, theirsVal);

      if (!oursChanged && !theirsChanged) {
        // Aucun côté n'a changé → garder base
        result[key] = baseVal;
        resolvedKeys++;
      } else if (oursChanged && !theirsChanged) {
        // Seul ours a changé → accepter ours
        result[key] = oursVal;
        resolvedKeys++;
      } else if (!oursChanged && theirsChanged) {
        // Seul theirs a changé → accepter theirs
        result[key] = theirsVal;
        resolvedKeys++;
      } else if (jsonEqual(oursVal, theirsVal)) {
        // Les deux ont fait la même modif → same_change
        result[key] = oursVal;
        resolvedKeys++;
      } else if (isObject(oursVal) && isObject(theirsVal) && isObject(baseVal)) {
        // Les deux ont modifié des objets → fusion récursive
        const sub = mergeObjects(baseVal, oursVal, theirsVal);
        if (sub.merged !== null) {
          result[key] = sub.merged;
          resolvedKeys += sub.resolvedKeys + 1;
          unresolvedKeys += sub.unresolvedKeys;
        } else {
          unresolvedKeys++;
          return { merged: null, resolvedKeys, unresolvedKeys };
        }
      } else {
        // Scalaires modifiés différemment → conflit non résolvable
        unresolvedKeys++;
        return { merged: null, resolvedKeys, unresolvedKeys };
      }
    }
  }

  return { merged: result, resolvedKeys, unresolvedKeys };
}

// ─── Indentation detection ────────────────────────────────

/**
 * Détecte le style d'indentation d'un fichier JSON (espaces ou tab).
 * Retourne le string d'indentation utilisé (ex: "  ", "    ", "\t").
 */
function detectIndentation(jsonText: string): string | number {
  const lines = jsonText.split("\n");
  for (const line of lines) {
    const match = line.match(/^(\t+|\s+)/);
    if (match) {
      const indent = match[1];
      if (indent.includes("\t")) return "\t";
      return indent.length;
    }
  }
  return 2; // défaut
}

// ─── Public API ───────────────────────────────────────────

/**
 * Tente de résoudre un conflit JSON en fusionnant sémantiquement
 * les trois versions.
 *
 * @param baseLines  - Lignes de la version base
 * @param oursLines  - Lignes de la version ours
 * @param theirsLines - Lignes de la version theirs
 * @returns `JsonMergeResult` avec `merged !== null` si résolu, `null` sinon
 */
export function tryResolveJsonConflict(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): JsonMergeResult {
  const baseText = baseLines.join("\n");
  const oursText = oursLines.join("\n");
  const theirsText = theirsLines.join("\n");

  // Tenter de parser les trois versions
  let baseJson: unknown;
  let oursJson: unknown;
  let theirsJson: unknown;

  try {
    baseJson = JSON.parse(stripJsoncComments(baseText) || "{}");
  } catch {
    // Base peut être vide (conflict sans diff3)
    baseJson = {};
  }

  try {
    oursJson = JSON.parse(stripJsoncComments(oursText));
  } catch (e) {
    return {
      merged: null,
      reason: `Impossible de parser ours comme JSON : ${e instanceof Error ? e.message : String(e)}`,
      resolvedKeys: 0,
      unresolvedKeys: 1,
    };
  }

  try {
    theirsJson = JSON.parse(stripJsoncComments(theirsText));
  } catch (e) {
    return {
      merged: null,
      reason: `Impossible de parser theirs comme JSON : ${e instanceof Error ? e.message : String(e)}`,
      resolvedKeys: 0,
      unresolvedKeys: 1,
    };
  }

  // Cas : les deux versions ne sont pas des objets (tableau, scalaire…)
  if (!isObject(oursJson) || !isObject(theirsJson)) {
    // Pour les tableaux ou scalaires, on peut tenter un merge basique
    if (Array.isArray(oursJson) && Array.isArray(theirsJson)) {
      // Pour l'instant, pas de merge sémantique des tableaux — fallback textuel
      return {
        merged: null,
        reason: "Fusion sémantique de tableaux JSON non supportée (fallback textuel).",
        resolvedKeys: 0,
        unresolvedKeys: 1,
      };
    }
    if (jsonEqual(oursJson, theirsJson)) {
      // Même valeur scalaire des deux côtés
      const indent = detectIndentation(oursText);
      return {
        merged: JSON.stringify(oursJson, null, indent),
        reason: "Même valeur JSON des deux côtés — résolution triviale.",
        resolvedKeys: 1,
        unresolvedKeys: 0,
      };
    }
    return {
      merged: null,
      reason: "Valeurs JSON scalaires différentes — fallback textuel.",
      resolvedKeys: 0,
      unresolvedKeys: 1,
    };
  }

  const baseObj = isObject(baseJson) ? baseJson : {};

  // Fusion sémantique
  const { merged, resolvedKeys, unresolvedKeys } = mergeObjects(
    baseObj,
    oursJson,
    theirsJson,
  );

  if (merged === null) {
    return {
      merged: null,
      reason: `Fusion JSON impossible : ${unresolvedKeys} clé(s) en conflit non résolvable.`,
      resolvedKeys,
      unresolvedKeys,
    };
  }

  // Reformater le JSON en préservant le style d'indentation de ours
  const indent = detectIndentation(oursText);
  const mergedText = JSON.stringify(merged, null, indent);

  return {
    merged: mergedText,
    reason: `Fusion JSON sémantique réussie : ${resolvedKeys} clé(s) fusionnée(s), ${unresolvedKeys} conflit(s).`,
    resolvedKeys,
    unresolvedKeys,
  };
}
