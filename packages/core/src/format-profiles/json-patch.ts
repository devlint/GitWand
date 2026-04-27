/**
 * GitWand — RFC 6902 (JSON Patch) minimal
 *
 * Implémentation maison, pas de dep externe. Couvre `add`, `remove`, `replace`.
 * `move` et `copy` non implémentées (gérées par séquences add/remove).
 *
 * Trois primitives :
 * - `diffJson(base, target)` produit la séquence d'ops qui transforme base en target.
 * - `applyJsonPatch(doc, ops)` applique séquentiellement, retourne le doc résultat
 *   (immutable — entrée non modifiée).
 * - `mergeJsonPatches(oursOps, theirsOps)` concatène si les paths sont disjoints,
 *   `null` si conflit (au moins une op des deux côtés sur le même path).
 *
 * JSON Pointer (RFC 6901) avec escape `~0` → `~` et `~1` → `/`.
 */

import type { JsonPatchOp } from "./types.js";

// ─── JSON Pointer (RFC 6901) ─────────────────────────────────

/**
 * Parse un JSON Pointer en tableau de tokens. Le pointer racine `""` retourne
 * `[]`. Chaque token est ré-échappé : `~0` → `~`, `~1` → `/`.
 */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (pointer[0] !== "/") {
    throw new Error(`Invalid JSON pointer: ${pointer} (must start with '/')`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((tok) => tok.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Construit un JSON Pointer depuis un tableau de tokens. Échappe `~` et `/`.
 */
export function buildJsonPointer(tokens: ReadonlyArray<string>): string {
  if (tokens.length === 0) return "";
  return (
    "/" +
    tokens
      .map((tok) => tok.replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

// ─── Apply ───────────────────────────────────────────────────

/** Type minimum pour parcourir un JSON. `null` est une valeur valide (pas une absence). */
type JsonValue = unknown;

function isPlainObject(v: JsonValue): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Clone superficiel d'un objet ou d'un tableau (immutabilité au niveau du parent). */
function shallowClone(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return [...v];
  if (isPlainObject(v)) return { ...v };
  return v;
}

/**
 * Applique une séquence d'opérations RFC 6902 à un document. Retourne le
 * nouveau document (l'entrée n'est pas modifiée). Lance une `Error` si une
 * opération réfère à un path inexistant (sauf `add` qui crée).
 */
export function applyJsonPatch(doc: JsonValue, ops: ReadonlyArray<JsonPatchOp>): JsonValue {
  let current: JsonValue = doc;
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
}

function applyOp(doc: JsonValue, op: JsonPatchOp): JsonValue {
  const tokens = parseJsonPointer(op.path);
  if (tokens.length === 0) {
    // Path racine — replace ou add remplace tout le doc, remove vide.
    if (op.op === "replace" || op.op === "add") return op.value;
    if (op.op === "remove") return undefined;
  }
  return applyAt(doc, tokens, 0, op);
}

function applyAt(node: JsonValue, tokens: string[], depth: number, op: JsonPatchOp): JsonValue {
  if (depth === tokens.length - 1) {
    const lastToken = tokens[depth];
    if (Array.isArray(node)) {
      const arr = [...node];
      if (op.op === "add") {
        if (lastToken === "-") {
          arr.push(op.value);
        } else {
          const idx = parseInt(lastToken, 10);
          if (!Number.isInteger(idx) || idx < 0 || idx > arr.length) {
            throw new Error(`Invalid array index: ${lastToken}`);
          }
          arr.splice(idx, 0, op.value);
        }
        return arr;
      }
      const idx = parseInt(lastToken, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) {
        throw new Error(`Invalid array index for ${op.op}: ${lastToken}`);
      }
      if (op.op === "remove") {
        arr.splice(idx, 1);
      } else {
        // replace
        arr[idx] = op.value;
      }
      return arr;
    }
    if (isPlainObject(node)) {
      const obj = { ...node };
      if (op.op === "add" || op.op === "replace") {
        obj[lastToken] = op.value;
      } else {
        // remove
        if (!(lastToken in obj)) {
          throw new Error(`Cannot remove non-existent key: ${lastToken}`);
        }
        delete obj[lastToken];
      }
      return obj;
    }
    throw new Error(`Cannot apply ${op.op} to non-container at ${tokens.join("/")}`);
  }

  // Intermediate token — descend.
  const token = tokens[depth];
  if (Array.isArray(node)) {
    const idx = parseInt(token, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
      throw new Error(`Invalid array index: ${token}`);
    }
    const arr = [...node];
    arr[idx] = applyAt(arr[idx], tokens, depth + 1, op);
    return arr;
  }
  if (isPlainObject(node)) {
    if (!(token in node)) {
      throw new Error(`Path does not exist: ${tokens.slice(0, depth + 1).join("/")}`);
    }
    const obj = { ...node };
    obj[token] = applyAt(obj[token], tokens, depth + 1, op);
    return obj;
  }
  throw new Error(`Cannot descend into non-container at ${tokens.slice(0, depth).join("/")}`);
}

// ─── Diff ────────────────────────────────────────────────────

/**
 * Calcule la séquence d'ops RFC 6902 qui transforme `base` en `target`.
 *
 * Stratégie : récursion structurelle. Sur les objets, on compare clé-par-clé
 * (ajout / remove / récursion). Sur les tableaux, on émet `replace` global
 * dès que les longueurs diffèrent ou qu'un élément à un index donné diffère —
 * pas de LCS-on-arrays ici (c'est le rôle des stratégies `set` / `ordered-list`
 * du registre, qui appellent `diffJson` à un niveau plus fin).
 */
export function diffJson(base: JsonValue, target: JsonValue): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  diffAt(base, target, [], ops);
  return ops;
}

function diffAt(base: JsonValue, target: JsonValue, path: string[], ops: JsonPatchOp[]): void {
  if (jsonStructEqual(base, target)) return;

  // Types divergents ou scalaires différents → replace.
  const baseIsObj = isPlainObject(base);
  const targetIsObj = isPlainObject(target);
  const baseIsArr = Array.isArray(base);
  const targetIsArr = Array.isArray(target);

  if (baseIsObj && targetIsObj) {
    const baseObj = base as Record<string, JsonValue>;
    const targetObj = target as Record<string, JsonValue>;
    const allKeys = new Set([...Object.keys(baseObj), ...Object.keys(targetObj)]);
    for (const key of allKeys) {
      const inBase = key in baseObj;
      const inTarget = key in targetObj;
      const childPath = [...path, key];
      if (inBase && inTarget) {
        diffAt(baseObj[key], targetObj[key], childPath, ops);
      } else if (!inBase && inTarget) {
        ops.push({ op: "add", path: buildJsonPointer(childPath), value: targetObj[key] });
      } else {
        // inBase && !inTarget
        ops.push({ op: "remove", path: buildJsonPointer(childPath) });
      }
    }
    return;
  }

  if (baseIsArr && targetIsArr) {
    // Comparaison naïve : si même longueur et chaque index égal → no-op
    // (déjà géré par le check d'égalité). Sinon replace global du tableau.
    ops.push({ op: "replace", path: buildJsonPointer(path), value: target });
    return;
  }

  // Type change ou scalaire différent.
  ops.push({ op: "replace", path: buildJsonPointer(path), value: target });
}

/** Égalité structurelle (récursive) entre deux JSON values. */
export function jsonStructEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonStructEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in b)) return false;
      if (!jsonStructEqual(a[k], (b as Record<string, JsonValue>)[k])) return false;
    }
    return true;
  }
  return false;
}

// ─── Merge ───────────────────────────────────────────────────

/**
 * Fusionne deux séquences d'ops. Si les paths sont disjoints (aucun path
 * touché par les deux), on retourne la concaténation `[...ours, ...theirs]`.
 * Sinon, on retourne `null` avec une liste des paths en conflit (utile pour
 * la `DecisionTrace`).
 *
 * Disjoint = aucun path d'`ours` n'est égal ni préfixe d'un path de `theirs`,
 * et vice versa. (Si `ours` modifie `/foo/bar` et `theirs` modifie `/foo`, ils
 * sont en conflit même si les chaînes ne sont pas identiques.)
 */
export function mergeJsonPatches(
  ours: ReadonlyArray<JsonPatchOp>,
  theirs: ReadonlyArray<JsonPatchOp>,
): { merged: JsonPatchOp[] | null; conflictingPaths: string[] } {
  const conflictingPaths: string[] = [];
  for (const op1 of ours) {
    for (const op2 of theirs) {
      if (pathsConflict(op1.path, op2.path)) {
        conflictingPaths.push(op1.path);
        break;
      }
    }
  }
  if (conflictingPaths.length > 0) {
    return { merged: null, conflictingPaths };
  }
  return { merged: [...ours, ...theirs], conflictingPaths: [] };
}

/**
 * Vrai si les deux paths se chevauchent (égaux, ou l'un préfixe de l'autre).
 */
function pathsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  // a préfixe de b : b commence par a + "/"
  if (b.startsWith(a + "/")) return true;
  if (a.startsWith(b + "/")) return true;
  return false;
}
