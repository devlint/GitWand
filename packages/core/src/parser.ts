/**
 * GitWand Conflict Parser
 *
 * Parse les fichiers contenant des marqueurs de conflit Git
 * et extrait les hunks structurés.
 *
 * Phase 7.1 : classifyConflict produit maintenant une DecisionTrace
 * complète — chaque étape d'évaluation est enregistrée avec sa raison.
 */

import type { ConflictHunk, ConflictType, Confidence, ConfidenceScore, DecisionTrace, TraceStep } from "./types.js";
import { mergeNonOverlapping } from "./diff.js";

// ─── Score de confiance composite ────────────────────────
//
// Phase 7.3b : chaque classification produit un ConfidenceScore
// avec les trois dimensions (typeClassification, dataRisk, scopeImpact)
// et des listes de boosters/penalties lisibles.

/**
 * Calcule le scopeImpact à partir du nombre total de lignes concernées.
 * 1–2 lignes → 0, 3–10 → 15, 11–30 → 35, >30 → 55
 */
function scopeImpact(lines: number): number {
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
function labelFromScore(score: number): Confidence {
  if (score >= 92) return "certain";
  if (score >= 68) return "high";
  if (score >= 44) return "medium";
  return "low";
}

/**
 * Construit un ConfidenceScore à partir des trois dimensions et des justifications.
 *
 * Formule : `score = typeClassification − dataRisk×0.4 − scopeImpact×0.15`
 */
function makeScore(
  typeClassification: number,
  dataRisk: number,
  si: number,
  boosters: string[],
  penalties: string[],
): ConfidenceScore {
  const raw = typeClassification - dataRisk * 0.4 - si * 0.15;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  return {
    score,
    label: labelFromScore(score),
    dimensions: { typeClassification, dataRisk, scopeImpact: si },
    boosters,
    penalties,
  };
}

// ─── Phase 7.2 — Whitespace normalization ────────────────
//
// Normalisation progressive pour la détection whitespace-only.
// Les étapes sont cumulatives et couvrent les cas les plus courants
// rencontrés en pratique (indentation tab/espace, reformatage auto).

/**
 * Normalise les lignes d'un bloc pour la comparaison whitespace-only.
 *
 * Étapes :
 *  1. Tabs → 2 espaces (normalise les fichiers mixtes tab/espace)
 *  2. Trim leading/trailing sur chaque ligne
 *  3. Strip des lignes vides en tête et queue du bloc
 *     (reformatage souvent ajoute/supprime des lignes vides aux bornes)
 *  4. Collapse des espaces internes multiples → un seul espace
 *     (reformatage de prose, align-inline dans configs)
 *
 * Résultat : chaîne normalisée prête pour une comparaison ===.
 */
function normalizeForWhitespaceCheck(lines: string[]): string {
  // 1. Tabs → 2 espaces
  let normalized = lines.map((l) => l.replace(/\t/g, "  "));

  // 2. Trim leading/trailing sur chaque ligne
  normalized = normalized.map((l) => l.trim());

  // 3. Strip lignes vides en tête et queue du bloc
  while (normalized.length > 0 && normalized[0] === "") normalized.shift();
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") normalized.pop();

  // 4. Collapse des espaces internes multiples → un seul espace
  //    (s'applique après trim — une ligne entière d'espaces est déjà "" à ce stade)
  normalized = normalized.map((l) => l.replace(/  +/g, " "));

  return normalized.join("\n");
}

/** Marqueurs de conflit Git standard */
const MARKER_OURS = /^<{7}\s/;
const MARKER_BASE = /^\|{7}\s/;
const MARKER_SEPARATOR = /^={7}$/;
const MARKER_THEIRS = /^>{7}\s/;

/** Représente un conflit brut extrait du fichier */
export interface RawConflict {
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
  startLine: number;
  endLine: number;
}

/**
 * Parse un fichier avec des marqueurs de conflit Git.
 *
 * Supporte les formats diff2 (sans base) et diff3 (avec base).
 *
 * @param content - Le contenu du fichier avec marqueurs de conflit
 * @returns Les segments (texte résolu + conflits bruts) dans l'ordre
 */
export function parseConflictMarkers(content: string): {
  segments: Array<{ type: "text"; lines: string[] } | { type: "conflict"; conflict: RawConflict }>;
} {
  const lines = content.split("\n");
  const segments: Array<
    { type: "text"; lines: string[] } | { type: "conflict"; conflict: RawConflict }
  > = [];

  let currentText: string[] = [];
  let inConflict = false;
  let section: "ours" | "base" | "theirs" = "ours";
  let conflictStart = 0;
  let oursLines: string[] = [];
  let baseLines: string[] = [];
  let theirsLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (MARKER_OURS.test(line)) {
      // Début d'un conflit
      if (currentText.length > 0) {
        segments.push({ type: "text", lines: [...currentText] });
        currentText = [];
      }
      inConflict = true;
      section = "ours";
      conflictStart = i + 1; // 1-indexed
      oursLines = [];
      baseLines = [];
      theirsLines = [];
      continue;
    }

    if (inConflict && MARKER_BASE.test(line)) {
      // Début de la section base (diff3)
      section = "base";
      continue;
    }

    if (inConflict && MARKER_SEPARATOR.test(line)) {
      // Séparateur entre ours/base et theirs
      section = "theirs";
      continue;
    }

    if (inConflict && MARKER_THEIRS.test(line)) {
      // Fin du conflit
      segments.push({
        type: "conflict",
        conflict: {
          oursLines: [...oursLines],
          baseLines: [...baseLines],
          theirsLines: [...theirsLines],
          startLine: conflictStart,
          endLine: i + 1,
        },
      });
      inConflict = false;
      continue;
    }

    if (inConflict) {
      switch (section) {
        case "ours":
          oursLines.push(line);
          break;
        case "base":
          baseLines.push(line);
          break;
        case "theirs":
          theirsLines.push(line);
          break;
      }
    } else {
      currentText.push(line);
    }
  }

  // Texte restant après le dernier conflit
  if (currentText.length > 0) {
    segments.push({ type: "text", lines: currentText });
  }

  return { segments };
}

// ─── Classification avec DecisionTrace (Phase 7.1) ────────
//
// Chaque branche de classifyConflict enregistre une étape dans `steps`.
// Les étapes rejetées (passed: false) expliquent POURQUOI un type n'a pas
// été sélectionné. L'étape finale (passed: true) explique le choix retenu.
//
// La trace est conçue pour être affichée directement dans l'UI (mode explain)
// ou loggée en CLI (--explain).

/**
 * Classifie un conflit brut avec trace complète du raisonnement.
 *
 * @returns Résultat de classification incluant la DecisionTrace (7.1)
 */
export function classifyConflict(conflict: RawConflict): {
  type: ConflictType;
  confidence: ConfidenceScore;
  explanation: string;
  trace: DecisionTrace;
} {
  const { oursLines, baseLines, theirsLines } = conflict;

  const oursText = oursLines.join("\n");
  const theirsText = theirsLines.join("\n");
  const baseText = baseLines.join("\n");
  const hasBase = baseLines.length > 0;

  const steps: TraceStep[] = [];

  // ─── 1. Same change ────────────────────────────────────
  if (oursText === theirsText) {
    steps.push({
      type: "same_change",
      passed: true,
      reason: "Les deux branches ont exactement le même contenu — modification identique des deux côtés.",
    });
    const trace: DecisionTrace = {
      steps,
      selected: "same_change",
      summary: "Même modification des deux côtés → résolution triviale.",
      hasBase,
    };
    return {
      type: "same_change",
      confidence: makeScore(100, 0, scopeImpact(oursLines.length), [
        "Les deux branches ont exactement le même contenu",
      ], []),
      explanation: "Les deux branches ont effectué exactement la même modification.",
      trace,
    };
  }
  steps.push({
    type: "same_change",
    passed: false,
    reason: "Les deux branches ont des contenus différents.",
  });

  // ─── Vérifications avec base (diff3) ──────────────────
  if (hasBase) {
    const oursMatchesBase = oursText === baseText;
    const theirsMatchesBase = theirsText === baseText;

    // ─── 2. Delete + no change ──────────────────────────
    if (oursLines.length === 0 && theirsMatchesBase) {
      steps.push({
        type: "delete_no_change",
        passed: true,
        reason: "Ours a supprimé le bloc (0 lignes) et theirs n'a pas modifié la base.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "delete_no_change",
        summary: "Ours a supprimé ce bloc, theirs est resté identique à la base.",
        hasBase,
      };
      return {
        type: "delete_no_change",
        confidence: makeScore(100, 5, 0, [
          "Base disponible",
          "Ours a supprimé, theirs identique à la base",
        ], []),
        explanation:
          "La branche courante (ours) a supprimé ce bloc, l'autre ne l'a pas modifié. Résolution : supprimer.",
        trace,
      };
    }

    if (theirsLines.length === 0 && oursMatchesBase) {
      steps.push({
        type: "delete_no_change",
        passed: true,
        reason: "Theirs a supprimé le bloc (0 lignes) et ours n'a pas modifié la base.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "delete_no_change",
        summary: "Theirs a supprimé ce bloc, ours est resté identique à la base.",
        hasBase,
      };
      return {
        type: "delete_no_change",
        confidence: makeScore(100, 5, 0, [
          "Base disponible",
          "Theirs a supprimé, ours identique à la base",
        ], []),
        explanation:
          "La branche entrante (theirs) a supprimé ce bloc, l'autre ne l'a pas modifié. Résolution : supprimer.",
        trace,
      };
    }

    steps.push({
      type: "delete_no_change",
      passed: false,
      reason: hasBase
        ? "Ni ours ni theirs n'est une suppression unilatérale avec l'autre côté identique à la base."
        : "Base indisponible — vérification delete_no_change sautée.",
    });

    // ─── 3. One-side change ─────────────────────────────
    if (oursMatchesBase && !theirsMatchesBase) {
      steps.push({
        type: "one_side_change",
        passed: true,
        reason: "Ours est identique à la base, seul theirs a changé.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "one_side_change",
        summary: "Seul theirs a modifié ce bloc — résolution : accepter theirs.",
        hasBase,
      };
      return {
        type: "one_side_change",
        confidence: makeScore(100, 0, scopeImpact(theirsLines.length), [
          "Base disponible",
          "Seul theirs a modifié le bloc",
        ], []),
        explanation:
          "Seule la branche entrante (theirs) a modifié ce bloc. Résolution : accepter theirs.",
        trace,
      };
    }

    if (!oursMatchesBase && theirsMatchesBase) {
      steps.push({
        type: "one_side_change",
        passed: true,
        reason: "Theirs est identique à la base, seul ours a changé.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "one_side_change",
        summary: "Seul ours a modifié ce bloc — résolution : accepter ours.",
        hasBase,
      };
      return {
        type: "one_side_change",
        confidence: makeScore(100, 0, scopeImpact(oursLines.length), [
          "Base disponible",
          "Seul ours a modifié le bloc",
        ], []),
        explanation:
          "Seule la branche courante (ours) a modifié ce bloc. Résolution : accepter ours.",
        trace,
      };
    }

    steps.push({
      type: "one_side_change",
      passed: false,
      reason: "Les deux branches ont modifié le bloc par rapport à la base.",
    });

    // ─── 4. Non-overlapping ─────────────────────────────
    const merged = mergeNonOverlapping(baseLines, oursLines, theirsLines);
    if (merged !== null) {
      steps.push({
        type: "non_overlapping",
        passed: true,
        reason: "Le merge 3-way LCS a réussi sans conflit — les modifications ne se chevauchent pas.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "non_overlapping",
        summary: "Modifications non-overlapping — fusion automatique par LCS 3-way.",
        hasBase,
      };
      const mergedSize = Math.max(oursLines.length, theirsLines.length);
      return {
        type: "non_overlapping",
        confidence: makeScore(90, 20, scopeImpact(mergedSize), [
          "Base disponible",
          "Merge LCS 3-way réussi sans chevauchement",
        ], []),
        explanation:
          "Les deux branches ont modifié des zones différentes du même bloc. Fusion automatique possible.",
        trace,
      };
    }

    steps.push({
      type: "non_overlapping",
      passed: false,
      reason: "Le merge 3-way LCS détecte un chevauchement — les deux branches ont modifié les mêmes lignes.",
    });
  } else {
    // Pas de base : on note que ces checks ont été sautés
    steps.push({
      type: "delete_no_change",
      passed: false,
      reason: "Base (diff3) indisponible — vérification basée sur la base sautée.",
    });
    steps.push({
      type: "one_side_change",
      passed: false,
      reason: "Base (diff3) indisponible — impossible de déterminer quel côté a changé par rapport à la base.",
    });
    steps.push({
      type: "non_overlapping",
      passed: false,
      reason: "Base (diff3) indisponible — merge 3-way LCS impossible.",
    });

    // ─── Suppression sans base (diff2) ──────────────────
    if (oursLines.length === 0 && theirsLines.length > 0) {
      steps.push({
        type: "delete_no_change",
        passed: true,
        reason: "Ours est vide (0 lignes) en diff2. Suppression probable mais incertaine sans base.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "delete_no_change",
        summary: "Ours a supprimé ce bloc (diff2 — sans base, confiance moyenne).",
        hasBase: false,
      };
      return {
        type: "delete_no_change",
        confidence: makeScore(60, 30, 0, [], [
          "Sans base (diff2) — suppression non confirmée par rapport à l'ancêtre commun",
        ]),
        explanation:
          "La branche courante (ours) a supprimé ce bloc. Sans base, confiance moyenne. Résolution proposée : supprimer.",
        trace,
      };
    }

    if (theirsLines.length === 0 && oursLines.length > 0) {
      steps.push({
        type: "delete_no_change",
        passed: true,
        reason: "Theirs est vide (0 lignes) en diff2. Suppression probable mais incertaine sans base.",
      });
      const trace: DecisionTrace = {
        steps,
        selected: "delete_no_change",
        summary: "Theirs a supprimé ce bloc (diff2 — sans base, confiance moyenne).",
        hasBase: false,
      };
      return {
        type: "delete_no_change",
        confidence: makeScore(60, 30, 0, [], [
          "Sans base (diff2) — suppression non confirmée par rapport à l'ancêtre commun",
        ]),
        explanation:
          "La branche entrante (theirs) a supprimé ce bloc. Sans base, confiance moyenne. Résolution proposée : supprimer.",
        trace,
      };
    }
  }

  // ─── 5. Whitespace-only ─────────────────────────────────
  // Phase 7.2 — Normalisation whitespace améliorée :
  //   1. Tabs → espaces (2 espaces, standard courant)
  //   2. Trim leading/trailing sur chaque ligne
  //   3. Collapse des espaces internes pour les fichiers prose (.md, .txt, .rst)
  //   4. Strip des lignes vides en tête/queue du bloc
  const oursNormalized = normalizeForWhitespaceCheck(oursLines);
  const theirsNormalized = normalizeForWhitespaceCheck(theirsLines);

  if (oursNormalized === theirsNormalized) {
    steps.push({
      type: "whitespace_only",
      passed: true,
      reason: "Après normalisation (trim), les deux versions sont identiques — seul le whitespace diffère.",
    });
    const trace: DecisionTrace = {
      steps,
      selected: "whitespace_only",
      summary: "Même code, whitespace différent — résolution : préférer ours.",
      hasBase,
    };
    return {
      type: "whitespace_only",
      confidence: makeScore(
        hasBase ? 95 : 80,
        10,
        scopeImpact(Math.max(oursLines.length, theirsLines.length)),
        hasBase
          ? ["Base disponible — whitespace confirmé par rapport à l'ancêtre", "Seul le whitespace diffère après normalisation"]
          : ["Seul le whitespace diffère après normalisation (trim)"],
        hasBase ? [] : ["Sans base (diff2) — hypothèse basée sur la normalisation uniquement"],
      ),
      explanation:
        "Les deux branches contiennent le même code avec des différences de whitespace uniquement.",
      trace,
    };
  }
  steps.push({
    type: "whitespace_only",
    passed: false,
    reason: "Après normalisation (trim), les deux versions restent différentes — pas seulement du whitespace.",
  });

  // ─── 6. Value-only change (diff2) ───────────────────────
  if (!hasBase && oursLines.length === theirsLines.length) {
    const valResult = detectValueOnlyChange(oursLines, theirsLines);
    if (valResult !== null) {
      steps.push({
        type: "value_only_change",
        passed: true,
        reason: valResult.traceReason,
      });
      const trace: DecisionTrace = {
        steps,
        selected: "value_only_change",
        summary: `Même structure, valeur(s) volatile(s) différente(s) — résolution : accepter theirs.`,
        hasBase: false,
      };
      return {
        type: "value_only_change",
        confidence: valResult.confidenceScore,
        explanation: valResult.explanation,
        trace,
      };
    }
    steps.push({
      type: "value_only_change",
      passed: false,
      reason: "Les différences entre ours et theirs ne se limitent pas à des valeurs volatiles (hash, version, timestamp…).",
    });
  } else if (hasBase) {
    // Avec base, on ne teste pas value_only_change (on a des mécanismes plus précis)
    steps.push({
      type: "value_only_change",
      passed: false,
      reason: "Base disponible — value_only_change est une heuristique diff2, non appliquée ici.",
    });
  } else {
    steps.push({
      type: "value_only_change",
      passed: false,
      reason: "Ours et theirs n'ont pas le même nombre de lignes — structure différente.",
    });
  }

  // ─── 7. Fallback — conflit complexe ─────────────────────
  steps.push({
    type: "complex",
    passed: true,
    reason: "Aucun pattern automatique ne s'applique — résolution manuelle requise.",
  });
  const trace: DecisionTrace = {
    steps,
    selected: "complex",
    summary: "Conflit complexe — toutes les heuristiques automatiques ont échoué.",
    hasBase,
  };
  return {
    type: "complex",
    confidence: makeScore(100, 100, 0, [], [
      "Aucune heuristique automatique applicable",
      "Les deux branches ont modifié le bloc de façon incompatible",
    ]),
    explanation:
      "Conflit complexe nécessitant une résolution manuelle. Les deux branches ont modifié ce bloc différemment.",
    trace,
  };
}

// ─── Patterns pour la détection de valeurs atomiques ────

// ─── Phase 7.2 — Patterns volatils affinés ───────────────
//
// Précision améliorée pour réduire les faux positifs dans detectValueOnlyChange.
// Le pattern générique `/[A-Za-z0-9_-]{6,12}/` était trop large — il matchait
// des identifiants de code (noms de fonctions, clés de config…) comme volatils.
//
// Critères pour qu'un token soit "volatile" (susceptible de changer sans conflit réel) :
//  - Hashes Git/contenu : hex pur, ≥ 7 chars, ne ressemble pas à un mot (pas de voyelles seules)
//  - UUID : format standard xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//  - Hashes de build courts : majuscules + chiffres ou camelCase court (Vite/Webpack output)
//  - Semver complet : N.N.N (avec pré-release facultatif)
//  - Timestamp : format date+heure reconnaissable
//  - URL complète : commence par http:// ou https://
//
// NON volatile : identifiants camelCase standards, noms de variables, clés de config textuelles

// ─── Phase 7.2 — Patterns volatils affinés ───────────────
//
// Précision améliorée pour réduire les faux positifs dans detectValueOnlyChange.
// L'ancien pattern générique `/[A-Za-z0-9_-]{6,12}/` était trop large — il matchait
// des identifiants de code normaux (noms de fonctions, clés de config…) comme volatils.
//
// Sont considérés "volatiles" uniquement les tokens reconnaissables comme :
//   - Hash Git/contenu : hex pur ≥7 chars (ex: a3f2c1d)
//   - UUID : format canonique (ex: f47ac10b-58cc-4372-a567-0e02b2c3d479)
//   - Hash de build court Vite/Webpack : mix obligatoire de maj + min + chiffres, 6–16 chars
//     (ex: DIwZRTuY, C3Po9xAB — distingué d'un mot par la présence de chiffres OU de maj isolées)
//   - Semver complet : N.N.N avec éventuel pre-release/build
//   - Timestamp ISO : date+heure reconnaissable
//   - URL complète : commence par http:// ou https://

/** Regex qui matche les tokens "volatiles" : hashes, UUIDs, semver, timestamps, URLs */
const VOLATILE_PATTERNS = [
  /^[a-f0-9]{7,64}$/,                                                 // git hash / hex hash (lowercase pur)
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // UUID standard
  /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d]{6,20}$/,               // build hash : maj+min+chiffre (ex: BVdDe8aQ)
  /^[~^>=<]*\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/,                    // semver (avec préfixe npm ^, ~, >=…)
  /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?([Z+\-]\S*)?$/,       // ISO timestamp
  /^(https?:)?\/\/\S+$/,                                              // URL complète ou protocol-relative
  /^[a-z][a-z0-9]{1,9}-[A-Za-z0-9+/=]{8,}$/,                        // intégrité npm : sha512-…, sha256-…
];

/**
 * Vérifie si deux tokens diffèrent uniquement par une sous-chaîne "hash-like".
 * Exemple : `assets/main-BVdDe8aQ.js` vs `assets/main-Dx9QwPzM.js`
 *            → prefix=`assets/main-`, suffix=`.js`, mid=`BVdDe8aQ` vs `Dx9QwPzM`
 */
function isPairwiseVolatile(a: string, b: string): boolean {
  if (a === b) return false;

  // Préfixe commun
  let prefixLen = 0;
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) {
    prefixLen++;
  }

  // Suffixe commun (sans empiéter sur le préfixe)
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

  // Il faut au moins un caractère de structure commune
  if (prefixLen + suffixLen === 0) return false;

  const aMid = a.slice(prefixLen, suffixLen > 0 ? a.length - suffixLen : undefined);
  const bMid = b.slice(prefixLen, suffixLen > 0 ? b.length - suffixLen : undefined);

  if (aMid.length === 0 || bMid.length === 0) return false;

  // La partie centrale doit ressembler à un hash ou correspondre à un pattern volatile
  const isHashLikeMid = (s: string): boolean => {
    if (VOLATILE_PATTERNS.some((p) => p.test(s))) return true;
    // Hash build alphanumérique pur : ≥7 chars, ≥2 majuscules, ≥2 minuscules
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
 * Tokenize une ligne en parties "structurelles" et "valeurs".
 * Split sur les délimiteurs structurels courants (espaces, ponctuation JSON/TS…).
 * On ne split PAS sur `.`, `-`, `/` pour préserver les tokens composites
 * comme les versions semver (`1.2.3`) et les UUIDs (`f47ac-...`).
 */
function tokenizeLine(line: string): string[] {
  return line.split(/(\s+|[{}[\](),:;"'`=<>])/);
}

/**
 * Détecte si deux ensembles de lignes ne diffèrent que par des valeurs atomiques
 * (hashes, versions, timestamps, URLs).
 *
 * Retourne la classification avec sa raison de trace, ou null si non applicable.
 */
function detectValueOnlyChange(
  oursLines: string[],
  theirsLines: string[],
): { confidenceScore: ConfidenceScore; explanation: string; traceReason: string } | null {
  if (oursLines.length !== theirsLines.length) return null;
  if (oursLines.length === 0) return null;

  let diffCount = 0;
  let totalTokens = 0;
  let allDiffsAreVolatile = true;

  for (let i = 0; i < oursLines.length; i++) {
    const oursTokens = tokenizeLine(oursLines[i]);
    const theirsTokens = tokenizeLine(theirsLines[i]);

    // Si le nombre de tokens est différent, la structure a changé
    if (oursTokens.length !== theirsTokens.length) {
      allDiffsAreVolatile = false;
      break;
    }

    totalTokens += oursTokens.length;

    for (let j = 0; j < oursTokens.length; j++) {
      if (oursTokens[j] !== theirsTokens[j]) {
        diffCount++;
        // Vérifier que les tokens qui diffèrent sont des valeurs volatiles
        const isOursVolatile = VOLATILE_PATTERNS.some((p) => p.test(oursTokens[j]));
        const isTheirsVolatile = VOLATILE_PATTERNS.some((p) => p.test(theirsTokens[j]));
        if (!isOursVolatile && !isTheirsVolatile) {
          // Vérification pairwise : les deux tokens ont la même structure sauf un hash
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

  // Calculer le ratio de différences pour ajuster la confiance
  const diffRatio = diffCount / Math.max(totalTokens, 1);
  // Phase 7.2 — seuils affinés pour réduire les faux positifs :
  //   ≤10% de tokens différents → typeClassification 88 (certain/high sûr)
  //   ≤20% → 72 (high)
  //   ≤30% → 55 (medium limit)
  //   >30% → rejeté (trop de différences pour être sûr des patterns volatils)
  const typeClassification =
    diffRatio <= 0.10 ? 88
    : diffRatio <= 0.20 ? 72
    : diffRatio <= 0.30 ? 55
    : 0; // rejet immédiat

  if (typeClassification < 55) return null; // Trop de différences pour être sûr

  const si = scopeImpact(oursLines.length);
  const confidenceScore = makeScore(typeClassification, 25, si, [
    `${diffCount} token${diffCount > 1 ? "s" : ""} identifié${diffCount > 1 ? "s" : ""} comme volatile${diffCount > 1 ? "s" : ""} (hash, version, timestamp…)`,
    "Même structure de lignes",
  ], [
    `Ratio de différences : ${(diffRatio * 100).toFixed(1)}%`,
    "Sans base (diff2) — heuristique basée sur les patterns volatils",
  ]);

  // Rejeter si le label reste "low" après calcul
  if (confidenceScore.label === "low") return null;

  const explanation =
    `Même structure avec ${diffCount} valeur${diffCount > 1 ? "s" : ""} volatile${diffCount > 1 ? "s" : ""} différente${diffCount > 1 ? "s" : ""} (hash, version, timestamp…). Résolution proposée : accepter la version la plus récente (theirs).`;

  const traceReason =
    `${diffCount} token${diffCount > 1 ? "s" : ""} différent${diffCount > 1 ? "s" : ""} sur ${totalTokens} — tous identifiés comme volatiles (hash, version, timestamp…). Ratio : ${(diffRatio * 100).toFixed(1)}% → score ${confidenceScore.score} (${confidenceScore.label}).`;

  return { confidenceScore, explanation, traceReason };
}

/**
 * Convertit un conflit brut en ConflictHunk typé avec trace (Phase 7.1).
 */
export function toConflictHunk(conflict: RawConflict): ConflictHunk {
  const { type, confidence, explanation, trace } = classifyConflict(conflict);

  return {
    baseLines: conflict.baseLines,
    oursLines: conflict.oursLines,
    theirsLines: conflict.theirsLines,
    startLine: conflict.startLine,
    type,
    confidence,
    explanation,
    trace,
  };
}
