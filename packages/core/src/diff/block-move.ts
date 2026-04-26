/**
 * GitWand — Détection de blocs déplacés (block-move)
 *
 * Approche Rabin-Karp : on hash chaque fenêtre de N lignes consécutives dans
 * `base`, `ours` et `theirs`, on cherche les fenêtres présentes dans **ours et
 * theirs mais pas dans base** (ou à des positions différentes), et on les
 * confirme littéralement (anti-collision).
 *
 * Usage v2.1 : primitive seule, exposée via `src/index.ts`. Les patterns
 * peuvent l'utiliser pour pénaliser le score de confiance de `complex` quand
 * un refactor massif est détecté côté ours et côté theirs (signal « pas
 * d'auto-résolution »). Cette dimension `algorithmStability` est wired dans
 * `ConfidenceScore` au commit suivant — mais aucun pattern ne la consomme
 * encore (la primitive sert pour la v2.6 refactoring-aware merge).
 */

/** Un bloc déplacé entre `ours` et `theirs`, absent de `base` à cette position. */
export interface MovedBlock {
  /** Les lignes brutes du bloc (depuis `ours`, non normalisées). */
  block: string[];
  /** Position de début dans `ours` (inclus). */
  oursPos: number;
  /** Position de début dans `theirs` (inclus). */
  theirsPos: number;
  /** Position dans `base` si la fenêtre y existe, sinon `null`. */
  basePos: number | null;
}

/** Options pour `detectBlockMove`. */
export interface BlockMoveOptions {
  /** Taille de la fenêtre de hash. Défaut 5 — équilibre robustesse vs sensibilité. */
  windowSize?: number;
  /**
   * Diversité minimale de tokens uniques (split sur whitespace + ponctuation)
   * dans la fenêtre normalisée — sous ce seuil, on skip pour éviter les faux
   * positifs sur les boucles `for (let i = 0; ...)` répétées. Défaut 4.
   */
  minTokenDiversity?: number;
}

const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_MIN_TOKEN_DIVERSITY = 4;

/**
 * Détecte les blocs de N lignes consécutives présents à la fois dans `ours` et
 * `theirs` mais absents (ou à une autre position) dans `base`.
 *
 * Heuristique anti-faux-positif :
 *  1. Whitespace trim sur chaque ligne pour le hash (le contenu du bloc reste
 *     original dans la sortie).
 *  2. Filtre `minTokenDiversity` : la fenêtre doit contenir suffisamment de
 *     tokens distincts pour ne pas matcher du code triviale répété.
 *  3. Confirmation littérale : après match de hash, comparaison ligne-à-ligne.
 *  4. Compaction : blocs adjacents fusionnés en un seul `MovedBlock` plus grand.
 *
 * @returns tableau de blocs déplacés détectés (vide si rien)
 */
export function detectBlockMove(
  base: string[],
  ours: string[],
  theirs: string[],
  opts?: BlockMoveOptions,
): MovedBlock[] {
  const W = opts?.windowSize ?? DEFAULT_WINDOW_SIZE;
  const minDiv = opts?.minTokenDiversity ?? DEFAULT_MIN_TOKEN_DIVERSITY;

  if (ours.length < W || theirs.length < W) return [];

  // ─── 1. Hash de chaque fenêtre dans les trois fichiers ─────
  const hashOurs = hashWindows(ours, W);
  const hashTheirs = hashWindows(theirs, W);
  const hashBase = hashWindows(base, W);

  // Index : pour chaque hash, la première position dans chaque fichier.
  const oursIndex = buildPositionIndex(hashOurs);
  const theirsIndex = buildPositionIndex(hashTheirs);
  const baseIndex = buildPositionIndex(hashBase);

  // ─── 2. Pour chaque hash présent dans ours ET theirs, vérifier ─
  const candidates: MovedBlock[] = [];

  for (const [hash, oursPositions] of oursIndex) {
    const theirsPositions = theirsIndex.get(hash);
    if (!theirsPositions) continue;

    // Considérer la première occurrence de chaque côté (les suivantes sont
    // gérées par compaction au step 3 si elles sont adjacentes).
    const oursPos = oursPositions[0];
    const theirsPos = theirsPositions[0];

    // Confirmation littérale (anti-collision Rabin-Karp).
    if (!windowsMatch(ours, oursPos, theirs, theirsPos, W)) continue;

    // Filtre de diversité de tokens.
    const block = ours.slice(oursPos, oursPos + W);
    if (countDistinctTokens(block) < minDiv) continue;

    // Position dans base : si la fenêtre y existe avec exactement le même
    // contenu, on note la position (utile au consommateur pour qualifier le
    // déplacement). Sinon `null` — la fenêtre est purement nouvelle des deux
    // côtés.
    const basePositions = baseIndex.get(hash);
    let basePos: number | null = null;
    if (basePositions) {
      for (const bp of basePositions) {
        if (windowsMatch(ours, oursPos, base, bp, W)) {
          basePos = bp;
          break;
        }
      }
      // Si la fenêtre est dans base à la même position relative dans les trois
      // fichiers (delta de position négligeable), ce n'est pas un block-move.
      if (basePos !== null && Math.abs(oursPos - basePos) < W && Math.abs(theirsPos - basePos) < W) {
        continue;
      }
    }

    candidates.push({ block, oursPos, theirsPos, basePos });
  }

  // ─── 3. Compaction : fusionner les blocs adjacents avec le même delta ─
  return compactAdjacent(candidates, W);
}

// ─── Utils internes ───────────────────────────────────────────

/** Polynomial rolling hash — base 257, modulo 2^32 (overflow naturel JS bit-ops). */
function hashWindows(lines: string[], W: number): number[] {
  const n = lines.length;
  if (n < W) return [];
  const hashes: number[] = new Array(n - W + 1);
  // Pré-calcule un hash sur la ligne normalisée (trim) pour stabilité whitespace.
  const lineHashes = lines.map((l) => stringHash(l.trim()));
  // Fenêtre : combine W line-hashes via une formule polynomiale.
  for (let i = 0; i + W <= n; i++) {
    let h = 0;
    for (let k = 0; k < W; k++) {
      h = (Math.imul(h, 257) + lineHashes[i + k]) | 0;
    }
    hashes[i] = h;
  }
  return hashes;
}

/** Hash 32-bit d'une chaîne (variante djb2). */
function stringHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Index hash → liste des positions où il apparaît. */
function buildPositionIndex(hashes: number[]): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    let arr = index.get(h);
    if (!arr) {
      arr = [];
      index.set(h, arr);
    }
    arr.push(i);
  }
  return index;
}

/** Compare littéralement deux fenêtres (ligne par ligne, contenu brut). */
function windowsMatch(
  a: string[],
  aPos: number,
  b: string[],
  bPos: number,
  W: number,
): boolean {
  for (let k = 0; k < W; k++) {
    if (a[aPos + k] !== b[bPos + k]) return false;
  }
  return true;
}

/** Nombre de tokens distincts dans un bloc (split simple sur whitespace + ponctuation). */
function countDistinctTokens(block: string[]): number {
  const tokens = new Set<string>();
  for (const line of block) {
    for (const t of line.split(/[\s{}[\](),:;"'`=<>+\-*/!?]+/)) {
      if (t.length > 0) tokens.add(t);
    }
  }
  return tokens.size;
}

/**
 * Fusionne les blocs adjacents avec la même paire (deltaOurs, deltaTheirs).
 * Deux candidats sont adjacents si la fenêtre suivante commence à exactement
 * `oursPos + 1` (et idem en theirs) — typique d'un grand bloc de longueur
 * L > W découpé en (L - W + 1) fenêtres qui se chevauchent.
 *
 * On track séparément la position de la *dernière* fenêtre fusionnée (`lastOursPos`,
 * `lastTheirsPos`) parce que `current.oursPos` reste figé sur le début du bloc
 * compacté. Un `basePos` non-null d'un candidat plus tardif gagne sur un null
 * antérieur (la moved-block info est précieuse).
 */
function compactAdjacent(candidates: MovedBlock[], W: number): MovedBlock[] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => a.oursPos - b.oursPos);
  const result: MovedBlock[] = [];
  let current = sorted[0];
  let lastOursPos = current.oursPos;
  let lastTheirsPos = current.theirsPos;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const isAdjacent =
      next.oursPos === lastOursPos + 1 &&
      next.theirsPos === lastTheirsPos + 1;
    if (isAdjacent) {
      current = {
        ...current,
        block: [...current.block, next.block[W - 1]],
        // basePos : si le candidat suivant en a un et nous pas (ou vice versa),
        // on garde celui qui est non-null. Si les deux en ont un avec un delta
        // constant vs oursPos, on garde le premier (sémantique : le bloc commence
        // à la position d'origine du déplacement).
        basePos: current.basePos ?? next.basePos,
      };
      lastOursPos = next.oursPos;
      lastTheirsPos = next.theirsPos;
    } else {
      result.push(current);
      current = next;
      lastOursPos = next.oursPos;
      lastTheirsPos = next.theirsPos;
    }
  }
  result.push(current);
  return result;
}
