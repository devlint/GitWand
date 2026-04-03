/**
 * GitWand Diff Utilities
 *
 * Algorithme LCS (Longest Common Subsequence) et 3-way merge
 * pour détecter et fusionner les changements non-overlapping.
 */

/** Une opération de diff sur une ligne */
export interface DiffOp {
  type: "keep" | "add" | "remove";
  line: string;
  /** Index dans le tableau source (base pour keep/remove, branch pour add) */
  index: number;
}

/**
 * Calcule la Longest Common Subsequence entre deux tableaux de lignes.
 * Retourne les indices des lignes communes dans chaque tableau.
 *
 * Utilise l'algorithme classique DP en O(n*m).
 */
export function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;

  // Table DP
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack pour trouver les paires d'indices
  const result: Array<[number, number]> = [];
  let i = n;
  let j = m;

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Calcule le diff entre une base et une branche.
 * Retourne la séquence d'opérations (keep, add, remove).
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
  const oursDiff = computeDiff(base, ours);
  const theirsDiff = computeDiff(base, theirs);

  const oursEdits = extractEdits(oursDiff, "ours");
  const theirsEdits = extractEdits(theirsDiff, "theirs");

  // Vérifier qu'aucun edit ne chevauche un edit de l'autre branche
  for (const oEdit of oursEdits) {
    for (const tEdit of theirsEdits) {
      if (editsOverlap(oEdit, tEdit)) {
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
