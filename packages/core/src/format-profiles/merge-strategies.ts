/**
 * GitWand — Stratégies de merge appliquées par les profils
 *
 * Trois fonctions clés exportées :
 *  - mergeArrayAsSet : merge 3-way de tableaux comme des sets (par identité)
 *  - mergeOrderedListViaPatch : merge 3-way de tableaux via RFC 6902 add/remove
 *  - tryMergeWithProfile : helper de haut niveau qui route base/ours/theirs en
 *    fonction de la stratégie, retourne null si non résolvable.
 *
 * Les fonctions sont génériques sur unknown et peuvent être appelées tant pour
 * des sous-arbres JSON que des sous-arbres YAML (le résolveur YAML les utilise
 * après yaml.parse → représentation JS-native).
 */

import type { JsonPatchOp, PathStrategy } from "./types.js";
import { diffJson, mergeJsonPatches, applyJsonPatch, jsonStructEqual } from "./json-patch.js";

/**
 * Merge 3-way de deux tableaux interprétés comme des sets identifiés par
 * `identity`. La sémantique :
 *
 *  - Pour chaque item présent dans ours OU theirs, on regarde s'il était dans
 *    la base.
 *  - Item ajouté d'un seul côté → ajouté au résultat.
 *  - Item modifié d'un seul côté (même identité, valeur différente) → version
 *    modifiée gagne.
 *  - Item modifié des deux côtés différemment → conflit, retour null.
 *  - Item supprimé d'un côté + non modifié de l'autre → supprimé du résultat.
 *  - Item supprimé d'un côté + modifié de l'autre → conflit.
 *
 * L'ordre du résultat suit ours pour les items qu'il contient, puis ajoute
 * en queue les nouveaux de theirs (sémantique "ours d'abord, theirs ensuite").
 */
export function mergeArrayAsSet(
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  identity: (item: unknown) => string,
): unknown[] | null {
  const baseMap = new Map<string, unknown>();
  for (const item of base) baseMap.set(identity(item), item);
  const oursMap = new Map<string, unknown>();
  for (const item of ours) oursMap.set(identity(item), item);
  const theirsMap = new Map<string, unknown>();
  for (const item of theirs) theirsMap.set(identity(item), item);

  // Préserve l'ordre d'ours. Les items dans theirs absents d'ours sont append en fin.
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const item of ours) {
    const k = identity(item);
    if (!seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }
  for (const item of theirs) {
    const k = identity(item);
    if (!seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }
  // Et les items présents en base mais ni dans ours ni dans theirs auraient
  // été supprimés des deux côtés — pas besoin de les visiter.

  const result: unknown[] = [];

  for (const key of orderedKeys) {
    const inBase = baseMap.has(key);
    const inOurs = oursMap.has(key);
    const inTheirs = theirsMap.has(key);
    const baseVal = baseMap.get(key);
    const oursVal = oursMap.get(key);
    const theirsVal = theirsMap.get(key);

    // Présent dans les deux branches
    if (inOurs && inTheirs) {
      if (jsonStructEqual(oursVal, theirsVal)) {
        result.push(oursVal);
        continue;
      }
      // Modifications divergentes
      if (inBase) {
        const oursChanged = !jsonStructEqual(baseVal, oursVal);
        const theirsChanged = !jsonStructEqual(baseVal, theirsVal);
        if (oursChanged && !theirsChanged) {
          result.push(oursVal);
          continue;
        }
        if (!oursChanged && theirsChanged) {
          result.push(theirsVal);
          continue;
        }
        // Les deux ont changé différemment → conflit
        return null;
      }
      // Pas dans la base, ajouts différents des deux côtés → conflit
      return null;
    }

    // Présent uniquement d'un côté
    if (inOurs && !inTheirs) {
      if (inBase) {
        // theirs a supprimé ; ours a-t-il modifié ?
        if (jsonStructEqual(baseVal, oursVal)) {
          // Pas modifié des deux côtés (suppression nette par theirs) → skip
          continue;
        }
        // ours a modifié, theirs a supprimé → conflit
        return null;
      }
      // Ajout pur côté ours
      result.push(oursVal);
      continue;
    }
    if (!inOurs && inTheirs) {
      if (inBase) {
        if (jsonStructEqual(baseVal, theirsVal)) {
          continue;
        }
        return null;
      }
      result.push(theirsVal);
      continue;
    }
  }

  return result;
}

/**
 * Merge 3-way d'un sous-arbre via RFC 6902 (add/remove/replace). Si les
 * deltas base→ours et base→theirs n'entrent pas en conflit (paths disjoints),
 * on applique séquentiellement les deux. Sinon, retourne null.
 */
export function mergeOrderedListViaPatch(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): unknown | null {
  const oursOps = diffJson(base, ours);
  const theirsOps = diffJson(base, theirs);
  const merged = mergeJsonPatches(oursOps, theirsOps);
  if (merged.merged === null) return null;
  return applyJsonPatch(base, merged.merged);
}

/**
 * Routeur de stratégie. Reçoit base/ours/theirs déjà parsés (JSON values) et
 * la PathStrategy à appliquer. Retourne la valeur fusionnée ou null.
 *
 * Note : "merge-keys" et "opaque" ne sont **pas** gérés ici — ils sont
 * délégués au pipeline existant (mergeObjects récursif côté json.ts) qui sait
 * descendre dans la structure. Ce module gère uniquement les stratégies qui
 * apportent quelque chose de nouveau en v2.2 (set, ordered-list).
 */
export function applyStrategy(
  strategy: PathStrategy,
  base: unknown,
  ours: unknown,
  theirs: unknown,
): { handled: true; value: unknown | null } | { handled: false } {
  if (strategy.kind === "set") {
    if (!Array.isArray(base) || !Array.isArray(ours) || !Array.isArray(theirs)) {
      return { handled: false };
    }
    const identity = strategy.identity ?? ((item: unknown) => JSON.stringify(item));
    return { handled: true, value: mergeArrayAsSet(base, ours, theirs, identity) };
  }
  if (strategy.kind === "ordered-list") {
    return { handled: true, value: mergeOrderedListViaPatch(base, ours, theirs) };
  }
  // merge-keys et opaque : non gérés ici.
  return { handled: false };
}

export type { JsonPatchOp };
