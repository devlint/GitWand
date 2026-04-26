/**
 * GitWand — Algorithme LCS (Longest Common Subsequence)
 *
 * Stratégie hybride DP plein (Int32Array) ↔ Hirschberg (mémoire O(min(n,m))),
 * équivalente en sortie observable. C'est le **backend legacy** depuis v2.1 :
 * la fonction publique `lcs()` réside dans `./index.ts` et route vers
 * `histogramDiff` par défaut. `GITWAND_DIFF=lcs` rebascule sur ce module pour
 * rollback ou comparaison.
 */

/**
 * Seuil au-delà duquel on bascule sur Hirschberg (mémoire O(min(n,m))) au lieu
 * du DP plein (mémoire O(n*m)). À 4M cellules → ~16MB avec un Int32Array, déjà
 * lourd en mémoire mais tolérable en pic. Au-dessus, Hirschberg est obligatoire
 * pour éviter un OOM sur les gros fichiers (lockfiles, bundles minifiés…).
 */
const HIRSCHBERG_THRESHOLD = 4_000_000;

/**
 * Calcule la Longest Common Subsequence entre deux tableaux de lignes.
 * Retourne les indices des lignes communes dans chaque tableau.
 *
 * Stratégie hybride :
 * - petit/moyen (n*m ≤ 4M cellules) → DP plein O(n*m) avec `Int32Array`
 *   (4 octets/cellule vs 8-16 octets pour des `number[][]`) ;
 * - gros → Hirschberg récursif, mémoire O(min(n,m)) + O(log n) de pile.
 *
 * Le comportement observable (tie-break, pairs retournées) est identique entre
 * les deux branches — voir `src/__tests__/diff.test.ts`.
 *
 * **Note v2.1** : exporté sous le nom `lcsLegacy` pour disambiguer du wrapper
 * public `lcs` (qui route vers Histogram par défaut). L'algo lui-même n'a pas
 * changé.
 */
export function lcsLegacy(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  if (n * m <= HIRSCHBERG_THRESHOLD) {
    return lcsDenseDP(a, b);
  }
  return lcsHirschberg(a, b);
}

/**
 * DP plein avec `Int32Array` (mémoire compacte, 4 octets/cellule).
 * Équivalent structurel à l'implémentation historique — même tie-break,
 * mêmes paires retournées.
 */
function lcsDenseDP(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  // Table DP aplatie : dp[i*W + j] ≡ dp[i][j].
  const dp = new Int32Array((n + 1) * W);

  for (let i = 1; i <= n; i++) {
    const row = i * W;
    const prev = (i - 1) * W;
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[row + j] = dp[prev + (j - 1)] + 1;
      } else {
        const up = dp[prev + j];
        const left = dp[row + (j - 1)];
        dp[row + j] = up > left ? up : left;
      }
    }
  }

  // Backtrack : mêmes règles de tie-break que l'implémentation historique.
  const result: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * W + j] > dp[i * W + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }
  result.reverse();
  return result;
}

/**
 * Implémentation Hirschberg exposée pour les tests (et usage avancé éventuel).
 * L'API publique `lcs()` choisit automatiquement entre cette variante et le DP
 * plein selon la taille de l'input. Exporter sous le préfixe `_` signale son
 * caractère d'interne-testable.
 */
export const _lcsHirschberg = (a: string[], b: string[]): Array<[number, number]> =>
  lcsHirschberg(a, b);

/**
 * Hirschberg : divide-and-conquer qui trouve le point de split optimal dans `a`
 * en utilisant seulement 2 lignes de DP (mémoire O(min(n,m))), puis recurse sur
 * les deux moitiés. Les paires LCS retournées peuvent différer de celles du DP
 * plein **sur les ties**, mais la longueur et la validité sont garanties.
 *
 * Stratégie pour rester iso-comportement avec `lcsDenseDP` :
 * - Sous un petit seuil de récursion (`n ≤ 2` ou `m ≤ 2`), on tombe sur des
 *   cas triviaux résolus directement (même tie-break que le DP plein).
 * - Le split choisit le `j*` qui maximise `scoreL[j] + scoreR[m - j]`, et en
 *   cas d'ex-æquo on prend le **plus petit** `j*` (équivalent au tie-break
 *   "j-- d'abord" du backtrack historique).
 */
function lcsHirschberg(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;

  // Cas de base : une seule ligne à gauche → chercher la première occurrence.
  if (n === 0 || m === 0) return [];
  if (n === 1) {
    const target = a[0];
    for (let j = 0; j < m; j++) {
      if (b[j] === target) return [[0, j]];
    }
    return [];
  }

  const mid = n >> 1; // n / 2 floor
  // Scores DP pour a[0..mid] contre b (forward), longueur m+1.
  const scoreL = lcsScoreRow(a, 0, mid, b, 0, m, false);
  // Scores DP pour a[mid..n] contre b (reverse), longueur m+1.
  const scoreR = lcsScoreRow(a, mid, n, b, 0, m, true);

  // Trouver le j* qui maximise scoreL[j] + scoreR[m - j].
  // En cas d'ex-æquo, on prend le plus petit j pour rester proche du tie-break
  // historique (backtrack « j-- en premier » ≈ préférer les splits « early »).
  let bestJ = 0;
  let bestScore = scoreL[0] + scoreR[m];
  for (let j = 1; j <= m; j++) {
    const s = scoreL[j] + scoreR[m - j];
    if (s > bestScore) {
      bestScore = s;
      bestJ = j;
    }
  }

  // Récursion + ajustement des indices pour la moitié droite.
  const left = lcsHirschberg(a.slice(0, mid), b.slice(0, bestJ));
  const rightRaw = lcsHirschberg(a.slice(mid), b.slice(bestJ));
  const right: Array<[number, number]> = rightRaw.map(([i, j]) => [i + mid, j + bestJ]);
  return left.concat(right);
}

/**
 * Calcule la dernière ligne du tableau DP LCS en 2 lignes (mémoire O(m+1)).
 *
 * @param a - tableau source pour la dimension « rows »
 * @param aStart - début (inclus) dans a
 * @param aEnd - fin (exclus) dans a
 * @param b - tableau source pour la dimension « cols »
 * @param bStart - début (inclus) dans b
 * @param bEnd - fin (exclus) dans b
 * @param reverse - si true, parcourt a et b à l'envers (pour Hirschberg)
 */
function lcsScoreRow(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number,
  reverse: boolean,
): Int32Array {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);

  for (let i = 1; i <= n; i++) {
    const ai = reverse ? a[aEnd - i] : a[aStart + i - 1];
    for (let j = 1; j <= m; j++) {
      const bj = reverse ? b[bEnd - j] : b[bStart + j - 1];
      if (ai === bj) {
        curr[j] = prev[j - 1] + 1;
      } else {
        const up = prev[j];
        const left = curr[j - 1];
        curr[j] = up > left ? up : left;
      }
    }
    // Swap prev ↔ curr (éviter une réallocation)
    const tmp = prev;
    prev = curr;
    curr = tmp;
    // Reset curr à 0 pour la prochaine itération
    curr.fill(0);
  }
  // Après la boucle, la dernière ligne calculée est dans `prev`.
  return prev;
}
