/**
 * GitWand — Utilitaires partagés entre les patterns
 *
 * Contient les fonctions de scoring, de normalisation et de détection
 * de valeurs volatiles utilisées par plusieurs PatternPlugin.
 */

import type { Confidence, ConfidenceScore } from "../types.js";

// ─── Scoring ─────────────────────────────────────────────────

/**
 * Calcule le scopeImpact à partir du nombre total de lignes concernées.
 * 1–2 lignes → 0, 3–10 → 15, 11–30 → 35, >30 → 55
 */
export function scopeImpact(lines: number): number {
  if (lines <= 2) return 0;
  if (lines <= 10) return 15;
  if (lines <= 30) return 35;
  return 55;
}

/**
 * Dérive le label Confidence depuis un score numérique 0–100.
 * - score ≥ 92 → "certain"
 * - score ≥ 68 → "high"
 * - score ≥ 44 → "medium"
 * - score <  44 → "low"
 */
export function labelFromScore(score: number): Confidence {
  if (score >= 92) return "certain";
  if (score >= 68) return "high";
  if (score >= 44) return "medium";
  return "low";
}

/**
 * Construit un ConfidenceScore à partir des dimensions et des justifications.
 *
 * Formule v2.4 :
 *   `score = typeClassification
 *           − dataRisk           × 0.40
 *           − scopeImpact        × 0.15
 *           − fileFrequency      × 0.10
 *           + baseAvailability   × 0.05
 *           − algorithmStability × 0.10
 *           − postMergeRisk      × 0.20`
 *
 * Tous les paramètres après `penalties` sont optionnels (défaut 0). Les
 * dimensions optionnelles (`algorithmStability`, `postMergeRisk`) ne sont
 * poussées dans l'objet `dimensions` que lorsqu'elles sont non-nulles, pour
 * que les snapshots de tests existants restent verts.
 */
export function makeScore(
  typeClassification: number,
  dataRisk: number,
  si: number,
  boosters: string[],
  penalties: string[],
  fileFrequency = 0,
  baseAvailability = 0,
  algorithmStability = 0,
  postMergeRisk = 0,
): ConfidenceScore {
  const raw =
    typeClassification
    - dataRisk            * 0.40
    - si                  * 0.15
    - fileFrequency       * 0.10
    + baseAvailability    * 0.05
    - algorithmStability  * 0.10
    - postMergeRisk       * 0.20;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const dimensions: ConfidenceScore["dimensions"] = {
    typeClassification,
    dataRisk,
    scopeImpact: si,
    fileFrequency,
    baseAvailability,
  };
  if (algorithmStability !== 0) {
    dimensions.algorithmStability = algorithmStability;
  }
  if (postMergeRisk !== 0) {
    dimensions.postMergeRisk = postMergeRisk;
  }
  return {
    score,
    label: labelFromScore(score),
    dimensions,
    boosters,
    penalties,
  };
}

// ─── Normalisation whitespace ─────────────────────────────────

/**
 * Normalise les lignes d'un bloc pour la comparaison whitespace-only.
 *
 * Étapes :
 *  1. Tabs → 2 espaces
 *  2. Trim leading/trailing sur chaque ligne
 *  3. Strip des lignes vides en tête et queue du bloc
 *  4. Collapse des espaces internes multiples → un seul espace
 */
export function normalizeForWhitespaceCheck(lines: string[]): string {
  let normalized = lines.map((l) => l.replace(/\t/g, "  "));
  normalized = normalized.map((l) => l.trim());
  while (normalized.length > 0 && normalized[0] === "") normalized.shift();
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") normalized.pop();
  normalized = normalized.map((l) => l.replace(/  +/g, " "));
  return normalized.join("\n");
}

/**
 * Normalise une ligne individuelle pour les comparaisons de patterns
 * (reorder_only, insertion_at_boundary).
 * Tabs → espaces, trim, collapse.
 */
export function normalizeLine(line: string): string {
  return line.replace(/\t/g, "  ").trim().replace(/  +/g, " ");
}

/**
 * Extrait la séquence des contenus de string literals (`"…"`, `'…'`, `` `…` ``)
 * d'un bloc de lignes, dans l'ordre. Scan naïf caractère par caractère avec
 * gestion de l'échappement `\"` — pas un vrai lexer (un apostrophe de prose
 * dans un commentaire ouvre une "string"), mais les deux côtés d'un conflit
 * subissent la même approximation : la comparaison des séquences reste
 * équitable, et l'erreur pousse vers le refus de résoudre (direction sûre).
 *
 * Utilisé par whitespace_only : le whitespace À L'INTÉRIEUR d'une string est
 * de la donnée, pas de la mise en forme — deux blocs "identiques modulo
 * whitespace" mais dont les strings diffèrent ne doivent pas être résolus
 * en préférant silencieusement un côté.
 */
export function extractQuotedSegments(lines: string[]): string[] {
  const text = lines.join("\n");
  const segments: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let content = "";
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < text.length) {
          content += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        content += text[i];
        i++;
      }
      segments.push(content);
      i++; // closing quote (or end of text)
      continue;
    }
    i++;
  }
  return segments;
}

// ─── Détection de valeurs volatiles ──────────────────────────

/** Regex qui matche les tokens "volatiles" : hashes, UUIDs, semver, timestamps, URLs */
export const VOLATILE_PATTERNS = [
  /^[a-f0-9]{7,64}$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d]{6,20}$/,
  /^[~^>=<]*\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/,
  /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?([Z+\-]\S*)?$/,
  /^(https?:)?\/\/\S+$/,
  /^[a-z][a-z0-9]{1,9}-[A-Za-z0-9+/=]{8,}$/,
];

/**
 * Vérifie si deux tokens diffèrent uniquement par une sous-chaîne "hash-like".
 */
export function isPairwiseVolatile(a: string, b: string): boolean {
  if (a === b) return false;

  let prefixLen = 0;
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const aRem = a.length - prefixLen;
  const bRem = b.length - prefixLen;
  while (
    suffixLen < aRem &&
    suffixLen < bRem &&
    a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  if (prefixLen + suffixLen === 0) return false;

  const aMid = a.slice(prefixLen, suffixLen > 0 ? a.length - suffixLen : undefined);
  const bMid = b.slice(prefixLen, suffixLen > 0 ? b.length - suffixLen : undefined);

  if (aMid.length === 0 || bMid.length === 0) return false;

  const isHashLikeMid = (s: string): boolean => {
    if (VOLATILE_PATTERNS.some((p) => p.test(s))) return true;
    if (s.length >= 7 && /^[A-Za-z\d]+$/.test(s)) {
      const upper = (s.match(/[A-Z]/g) ?? []).length;
      const lower = (s.match(/[a-z]/g) ?? []).length;
      if (upper >= 2 && lower >= 2) return true;
    }
    return false;
  };

  return isHashLikeMid(aMid) && isHashLikeMid(bMid);
}

/**
 * Tokenize une ligne en parties structurelles et valeurs.
 */
export function tokenizeLine(line: string): string[] {
  return line.split(/(\s+|[{}[\](),:;"'`=<>])/);
}

/**
 * Variante quote-aware de tokenizeLine : le contenu d'une string literal est
 * gardé ATOMIQUE (un seul token), quotes émises comme délimiteurs séparés.
 *
 * Indispensable pour les valeurs volatiles multi-mots : `'2026-07-06 11:42:00'`
 * splitté sur l'espace donne deux fragments dont aucun ne matche la regex
 * datetime — le cas résiduel le plus récurrent du corpus réel (config PHP
 * `last_update`). Utilisé par detectValueOnlyChange/pickNewerVersionSide ;
 * token_level_merge garde volontairement tokenizeLine (fusion INTRA-string
 * voulue là-bas, cf. ses fixtures Tailwind).
 */
export function tokenizeLineQuoteAware(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain !== "") {
      tokens.push(...plain.split(/(\s+|[{}[\](),:;=<>])/).filter((t) => t !== ""));
      plain = "";
    }
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      flushPlain();
      const quote = ch;
      let content = "";
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\" && i + 1 < line.length) {
          content += line[i] + line[i + 1];
          i += 2;
          continue;
        }
        content += line[i];
        i++;
      }
      tokens.push(quote);
      if (content !== "") tokens.push(content);
      if (i < line.length) { tokens.push(quote); i++; }
      continue;
    }
    plain += ch;
    i++;
  }
  flushPlain();
  return tokens;
}

/**
 * Détecte si deux ensembles de lignes ne diffèrent que par des valeurs atomiques.
 * Retourne un résultat de classification ou null si non applicable.
 */
export function detectValueOnlyChange(
  oursLines: string[],
  theirsLines: string[],
  hasBase = false,
): { confidenceScore: ConfidenceScore; explanation: string; traceReason: string } | null {
  if (oursLines.length !== theirsLines.length) return null;
  if (oursLines.length === 0) return null;

  let diffCount = 0;
  let totalTokens = 0;
  let allDiffsAreVolatile = true;

  for (let i = 0; i < oursLines.length; i++) {
    const oursTokens = tokenizeLineQuoteAware(oursLines[i]);
    const theirsTokens = tokenizeLineQuoteAware(theirsLines[i]);

    if (oursTokens.length !== theirsTokens.length) {
      allDiffsAreVolatile = false;
      break;
    }

    // Dénominateur du ratio : granularité de l'ancien tokenizeLine (dont les
    // chaînes vides d'artefact de split) — les seuils de typeClassification
    // (10/20/30 %) ont été calibrés sur cette granularité-là. La boucle de
    // comparaison, elle, travaille sur les tokens quote-aware.
    totalTokens += tokenizeLine(oursLines[i]).length;

    for (let j = 0; j < oursTokens.length; j++) {
      if (oursTokens[j] !== theirsTokens[j]) {
        diffCount++;
        const isOursVolatile = VOLATILE_PATTERNS.some((p) => p.test(oursTokens[j]));
        const isTheirsVolatile = VOLATILE_PATTERNS.some((p) => p.test(theirsTokens[j]));
        if (!isOursVolatile && !isTheirsVolatile) {
          if (!isPairwiseVolatile(oursTokens[j], theirsTokens[j])) {
            allDiffsAreVolatile = false;
            break;
          }
        }
      }
    }

    if (!allDiffsAreVolatile) break;
  }

  if (!allDiffsAreVolatile || diffCount === 0) return null;

  const diffRatio = diffCount / Math.max(totalTokens, 1);
  const typeClassification =
    diffRatio <= 0.10 ? 88
    : diffRatio <= 0.20 ? 72
    : diffRatio <= 0.30 ? 55
    : 0;

  if (typeClassification < 55) return null;

  const si = scopeImpact(oursLines.length);
  const penalties = [`Ratio de différences : ${(diffRatio * 100).toFixed(1)}%`];
  if (!hasBase) penalties.push("Sans base (diff2) — heuristique basée sur les patterns volatils");
  const confidenceScore = makeScore(typeClassification, 25, si, [
    `${diffCount} token${diffCount > 1 ? "s" : ""} identifié${diffCount > 1 ? "s" : ""} comme volatile${diffCount > 1 ? "s" : ""} (hash, version, timestamp…)`,
    "Même structure de lignes",
    ...(hasBase ? ["Base disponible — les deux côtés ont changé la valeur"] : []),
  ], penalties, 0, hasBase ? 100 : 0);

  if (confidenceScore.label === "low") return null;

  const explanation =
    `Même structure avec ${diffCount} valeur${diffCount > 1 ? "s" : ""} volatile${diffCount > 1 ? "s" : ""} différente${diffCount > 1 ? "s" : ""} (hash, version, timestamp…). Résolution : semver le plus élevé si comparable, sinon selon la politique de merge.`;

  const traceReason =
    `${diffCount} token${diffCount > 1 ? "s" : ""} différent${diffCount > 1 ? "s" : ""} sur ${totalTokens} — tous identifiés comme volatiles (hash, version, timestamp…). Ratio : ${(diffRatio * 100).toFixed(1)}% → score ${confidenceScore.score} (${confidenceScore.label}).`;

  return { confidenceScore, explanation, traceReason };
}


// ─── Comparaison semver pour value_only_change ────────────────

const RE_SEMVER_TOKEN = /^[~^>=<]*(\d+)\.(\d+)\.(\d+)(-[\w.]+)?(\+[\w.]+)?$/;

/** Datetime ISO-ish `YYYY-MM-DD[ T]HH:MM[:SS]` — l'ordre lexicographique EST l'ordre chronologique. */
const RE_DATETIME_TOKEN = /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?([Z+\-]\S*)?$/;

function parseSemver(tok: string): [number, number, number, boolean] | null {
  const m = tok.match(RE_SEMVER_TOKEN);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined];
}

/** -1 si a < b, 0 si égal, 1 si a > b. Une pre-release est inférieure à la release du même triple. */
function compareSemver(a: [number, number, number, boolean], b: [number, number, number, boolean]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
  }
  if (a[3] !== b[3]) return a[3] ? -1 : 1; // pre-release < release
  return 0;
}

/**
 * Si TOUTES les paires de tokens qui diffèrent entre ours et theirs sont des
 * semver comparables ET que le même côté est ≥ sur chaque paire (avec au
 * moins un >), retourne ce côté. Sinon null (résolution par politique).
 *
 * Consommé par assembleResolution (value_only_change) : « accepter la version
 * la plus récente » n'est déterministe que quand les valeurs sont ORDONNABLES
 * (semver, ou datetime ISO où l'ordre lexicographique est chronologique) —
 * pour les hashes et autres valeurs ambiguës on retombe sur la politique.
 */
export function pickNewerSemverSide(
  oursLines: string[],
  theirsLines: string[],
): "ours" | "theirs" | null {
  if (oursLines.length !== theirsLines.length) return null;
  let winner: "ours" | "theirs" | null = null;
  for (let i = 0; i < oursLines.length; i++) {
    const oursTokens = tokenizeLineQuoteAware(oursLines[i]);
    const theirsTokens = tokenizeLineQuoteAware(theirsLines[i]);
    if (oursTokens.length !== theirsTokens.length) return null;
    for (let j = 0; j < oursTokens.length; j++) {
      if (oursTokens[j] === theirsTokens[j]) continue;
      let cmp: number;
      const a = parseSemver(oursTokens[j]);
      const b = parseSemver(theirsTokens[j]);
      if (a && b) {
        cmp = compareSemver(a, b);
      } else if (RE_DATETIME_TOKEN.test(oursTokens[j]) && RE_DATETIME_TOKEN.test(theirsTokens[j])) {
        // Format ISO : comparaison lexicographique = chronologique.
        cmp = oursTokens[j] < theirsTokens[j] ? -1 : oursTokens[j] > theirsTokens[j] ? 1 : 0;
      } else {
        return null; // paire ni semver ni datetime → politique
      }
      if (cmp === 0) continue;
      const side = cmp > 0 ? "ours" : "theirs";
      if (winner !== null && winner !== side) return null; // désaccord entre paires
      winner = side;
    }
  }
  return winner;
}
