/**
 * GitWand — Helpers partagés au-dessus du backend diff
 *
 * `computeDiff`, `extractEdits`, `editsOverlap`, `mergeNonOverlapping` n'appartiennent
 * pas à un algorithme particulier — ce sont des opérations *sur* le résultat d'un
 * LCS. On les isole de l'implémentation pour pouvoir échanger librement le backend
 * (`lcsLegacy` ↔ `histogramDiff`) sans toucher cette couche.
 */

import { lcs } from "./index.js";

/** Une opération de diff sur une ligne */
export interface DiffOp {
  type: "keep" | "add" | "remove";
  line: string;
  /** Index dans le tableau source (base pour keep/remove, branch pour add) */
  index: number;
}

/**
 * Calcule le diff entre une base et une branche.
 * Retourne la séquence d'opérations (keep, add, remove).
 *
 * Utilise le backend `lcs()` du module index (Histogram par défaut depuis v2.1,
 * `lcsLegacy` si `GITWAND_DIFF=lcs`).
 */
export function computeDiff(base: string[], branch: string[]): DiffOp[] {
  const common = lcs(base, branch);
  const ops: DiffOp[] = [];

  let baseIdx = 0;
  let branchIdx = 0;

  for (const [bIdx, rIdx] of common) {
    // Lignes supprimées de la base (avant le prochain match)
    while (baseIdx < bIdx) {
      ops.push({ type: "remove", line: base[baseIdx], index: baseIdx });
      baseIdx++;
    }
    // Lignes ajoutées dans la branche (avant le prochain match)
    while (branchIdx < rIdx) {
      ops.push({ type: "add", line: branch[branchIdx], index: branchIdx });
      branchIdx++;
    }
    // Ligne commune
    ops.push({ type: "keep", line: base[baseIdx], index: baseIdx });
    baseIdx++;
    branchIdx++;
  }

  // Lignes restantes après le dernier match
  while (baseIdx < base.length) {
    ops.push({ type: "remove", line: base[baseIdx], index: baseIdx });
    baseIdx++;
  }
  while (branchIdx < branch.length) {
    ops.push({ type: "add", line: branch[branchIdx], index: branchIdx });
    branchIdx++;
  }

  return ops;
}

/**
 * Représente un changement (edit) d'une branche par rapport à la base.
 * start/end sont les indices dans la base où le changement s'applique.
 */
export interface Edit {
  /** Index de début dans la base (inclus) — position avant laquelle insérer ou début de la zone supprimée */
  baseStart: number;
  /** Index de fin dans la base (exclus) — fin de la zone supprimée */
  baseEnd: number;
  /** Lignes ajoutées à cette position */
  addedLines: string[];
  /** Source : "ours" ou "theirs" */
  source: "ours" | "theirs";
}

/**
 * Extrait les edits (changements groupés) d'un diff.
 * Chaque groupe contigu de add/remove forme un edit.
 */
export function extractEdits(
  diff: DiffOp[],
  source: "ours" | "theirs",
): Edit[] {
  const edits: Edit[] = [];
  let i = 0;

  while (i < diff.length) {
    if (diff[i].type === "keep") {
      i++;
      continue;
    }

    // Début d'un groupe de changements
    const removedLines: number[] = [];
    const addedLines: string[] = [];

    while (i < diff.length && diff[i].type !== "keep") {
      if (diff[i].type === "remove") {
        removedLines.push(diff[i].index);
      } else {
        addedLines.push(diff[i].line);
      }
      i++;
    }

    const baseStart =
      removedLines.length > 0
        ? removedLines[0]
        : // Pour un pur ajout, on utilise l'index de la prochaine ligne keep
          findNextKeepBaseIndex(diff, i);
    const baseEnd =
      removedLines.length > 0
        ? removedLines[removedLines.length - 1] + 1
        : baseStart; // Pur ajout : pas de suppression

    edits.push({ baseStart, baseEnd, addedLines, source });
  }

  return edits;
}

/** Trouve l'index base de la prochaine opération "keep" à partir de la position i */
function findNextKeepBaseIndex(diff: DiffOp[], fromIdx: number): number {
  for (let j = fromIdx; j < diff.length; j++) {
    if (diff[j].type === "keep") {
      return diff[j].index;
    }
  }
  // Si pas de keep après, c'est un ajout en fin de fichier
  // On retourne l'index après la dernière ligne de la base
  for (let j = diff.length - 1; j >= 0; j--) {
    if (diff[j].type === "keep" || diff[j].type === "remove") {
      return diff[j].index + 1;
    }
  }
  return 0;
}

/**
 * Vérifie si deux edits se chevauchent (overlap).
 * Deux edits overlap si leurs zones dans la base se croisent.
 */
export function editsOverlap(a: Edit, b: Edit): boolean {
  // Les edits sont des intervalles [baseStart, baseEnd) dans la base
  // Ils overlap si un commence avant que l'autre finisse

  // Cas spécial : deux purs ajouts au même point
  if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) {
    return a.baseStart === b.baseStart;
  }

  // Cas spécial : un pur ajout à un point touché par l'autre
  if (a.baseStart === a.baseEnd) {
    return a.baseStart >= b.baseStart && a.baseStart < b.baseEnd;
  }
  if (b.baseStart === b.baseEnd) {
    return b.baseStart >= a.baseStart && b.baseStart < a.baseEnd;
  }

  // Cas général : overlap d'intervalles
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/**
 * Tente de fusionner les changements non-overlapping de deux branches.
 *
 * @returns Les lignes fusionnées, ou null si les changements se chevauchent
 */
export function mergeNonOverlapping(
  base: string[],
  ours: string[],
  theirs: string[],
): string[] | null {
  // Lignes identiques en tête et en queue des deux côtés : on les sort de la
  // zone à fusionner, comme le fait zdiff3. Sans ça, un hunk diff3 où les deux
  // branches ajoutent les mêmes lignes les voit comme deux insertions
  // distinctes, et le résultat les contient deux fois.
  let prefix = 0;
  while (
    prefix < ours.length &&
    prefix < theirs.length &&
    ours[prefix] === theirs[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < ours.length - prefix &&
    suffix < theirs.length - prefix &&
    ours[ours.length - 1 - suffix] === theirs[theirs.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (prefix === 0 && suffix === 0) {
    return mergeEdits(base, ours, theirs);
  }

  // La part de ces lignes que la base a aussi est du contexte inchangé : on la
  // retire des trois versions. Le reste a été ajouté par les deux branches.
  let basePrefix = 0;
  while (
    basePrefix < prefix &&
    basePrefix < base.length &&
    base[basePrefix] === ours[basePrefix]
  ) {
    basePrefix++;
  }
  let baseSuffix = 0;
  while (
    baseSuffix < suffix &&
    baseSuffix < base.length - basePrefix &&
    base[base.length - 1 - baseSuffix] === ours[ours.length - 1 - baseSuffix]
  ) {
    baseSuffix++;
  }

  const middle = mergeEdits(
    base.slice(basePrefix, base.length - baseSuffix),
    ours.slice(prefix, ours.length - suffix),
    theirs.slice(prefix, theirs.length - suffix),
  );
  if (middle === null) return null;
  return [
    ...ours.slice(0, prefix),
    ...middle,
    ...ours.slice(ours.length - suffix),
  ];
}

/**
 * Une insertion pure posée juste après un edit de l'autre branche, alors que
 * cet edit ajoute déjà certaines des mêmes lignes : l'ordre et le
 * dédoublonnage sont ambigus, on laisse la décision à l'utilisateur.
 */
function duplicatesAtBoundary(a: Edit, b: Edit): boolean {
  const insertion = a.baseStart === a.baseEnd ? a : b.baseStart === b.baseEnd ? b : null;
  if (insertion === null) return false;
  const other = insertion === a ? b : a;
  if (insertion.baseStart !== other.baseEnd) return false;
  const added = new Set(other.addedLines);
  return insertion.addedLines.some((line) => added.has(line));
}

function mergeEdits(
  base: string[],
  ours: string[],
  theirs: string[],
): string[] | null {
  const oursDiff = computeDiff(base, ours);
  const theirsDiff = computeDiff(base, theirs);

  const oursEdits = extractEdits(oursDiff, "ours");
  const theirsEdits = extractEdits(theirsDiff, "theirs");

  // Vérifier qu'aucun edit ne chevauche un edit de l'autre branche
  for (const oEdit of oursEdits) {
    for (const tEdit of theirsEdits) {
      if (editsOverlap(oEdit, tEdit) || duplicatesAtBoundary(oEdit, tEdit)) {
        return null; // Overlap détecté → pas de résolution automatique
      }
    }
  }

  // Fusionner les edits triés par position dans la base
  const allEdits = [...oursEdits, ...theirsEdits].sort(
    (a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd,
  );

  // Reconstruire le fichier fusionné
  const result: string[] = [];
  let baseIdx = 0;

  for (const edit of allEdits) {
    // Copier les lignes de la base jusqu'au début de l'edit
    while (baseIdx < edit.baseStart) {
      result.push(base[baseIdx]);
      baseIdx++;
    }

    // Ajouter les lignes de l'edit
    result.push(...edit.addedLines);

    // Avancer au-delà de la zone supprimée
    if (edit.baseEnd > baseIdx) {
      baseIdx = edit.baseEnd;
    }
  }

  // Copier le reste de la base
  while (baseIdx < base.length) {
    result.push(base[baseIdx]);
    baseIdx++;
  }

  return result;
}
