/**
 * GitWand Core Types
 *
 * Représente les structures de données pour l'analyse
 * et la résolution automatique de conflits Git.
 */

/** Les trois versions d'un fichier en conflit */
export interface MergeInput {
  /** Contenu de la version ancêtre commune (base) */
  base: string;
  /** Contenu de la branche courante (ours / current) */
  ours: string;
  /** Contenu de la branche entrante (theirs / incoming) */
  theirs: string;
  /** Chemin du fichier (pour le reporting) */
  filePath: string;
}

/** Classification du type de conflit */
export type ConflictType =
  | "one_side_change"           // Seul un côté a modifié par rapport à la base
  | "same_change"               // Les deux côtés ont fait la même modification
  | "non_overlapping"           // Ajouts à des endroits différents (ex: imports)
  | "whitespace_only"           // Différences de whitespace uniquement
  | "delete_no_change"          // Un côté supprime, l'autre n'a pas touché
  | "generated_file"            // Fichier auto-généré (lock, manifest, min.js…)
  | "value_only_change"         // Même structure, seule une valeur change (hash, version, timestamp…)
  | "reorder_only"              // v1.4 — mêmes lignes, ordre différent (permutation pure)
  | "insertion_at_boundary"     // v1.4 — insertions pures des deux côtés, base intacte
  | "complex";                  // Conflit réel nécessitant intervention humaine

/** Niveau de confiance discret (label seuil, utilisé dans les options) */
export type Confidence = "certain" | "high" | "medium" | "low";

// ─── Phase 7.3b — Score de confiance composite ───────────
//
// Remplace le label discret par un score multidimensionnel.
// Le `label` est dérivé automatiquement du `score` pour la
// compatibilité avec les options `minConfidence`.

/**
 * Score de confiance composite pour la résolution automatique.
 *
 * Dimensions du score :
 * - `typeClassification` : certitude du type détecté (0–100)
 * - `dataRisk`           : risque de perte de données si résolution auto (0–100, 0 = sûr)
 * - `scopeImpact`        : impact de la taille du changement (0–100, 0 = petit)
 * - `fileFrequency`      : v1.4 — pénalité si le fichier a déjà des hunks complexes (0–100)
 * - `baseAvailability`   : v1.4 — bonus si la base diff3/zdiff3 est disponible (0 ou 100)
 *
 * Formule v1.4 :
 *   `score = typeClassification
 *           − dataRisk        × 0.40
 *           − scopeImpact     × 0.15
 *           − fileFrequency   × 0.10
 *           + baseAvailability × 0.05`
 *
 * Label dérivé :
 * - score ≥ 92 → `"certain"`
 * - score ≥ 68 → `"high"`
 * - score ≥ 44 → `"medium"`
 * - score <  44 → `"low"`
 */
export interface ConfidenceScore {
  /** Score global normalisé 0–100 */
  score: number;
  /** Label seuil backward-compatible, dérivé du score */
  label: Confidence;
  /** Dimensions explicatives du score */
  dimensions: {
    /** Certitude de la classification du type de conflit (0–100) */
    typeClassification: number;
    /** Risque de corruption/perte de données (0–100, 0 = sans risque) */
    dataRisk: number;
    /** Impact de la taille du changement (0–100, 0 = petit) */
    scopeImpact: number;
    /**
     * v1.4 — Pénalité "zone chaude" : nombre de hunks complexes déjà vus dans le même fichier.
     * Réduit la confiance pour éviter la sur-résolution dans les fichiers très conflictuels.
     * `fileFrequency = min(100, priorComplexHunksInFile × 20)`
     */
    fileFrequency: number;
    /**
     * v1.4 — Bonus de disponibilité de la base diff3/zdiff3.
     * 100 si la base est disponible (diff3 ou zdiff3), 0 sinon (diff2).
     */
    baseAvailability: number;
  };
  /** Facteurs ayant augmenté le score (justifications de haute confiance) */
  boosters: string[];
  /** Facteurs ayant diminué le score (raisons de prudence) */
  penalties: string[];
}

// ─── Phase 7.1 — DecisionTrace ────────────────────────────
//
// Trace structurée de la décision de classification d'un conflit.
// Permet à un développeur de comprendre POURQUOI un hunk a été classifié
// d'une certaine façon, sans magie.

/** Une étape de l'évaluation de la classification */
export interface TraceStep {
  /** Type de conflit évalué à cette étape */
  type: ConflictType;
  /** Cette étape a-t-elle produit la classification finale ? */
  passed: boolean;
  /** Raison lisible — pourquoi ce type a été accepté ou rejeté */
  reason: string;
}

/**
 * Trace complète du raisonnement de classification d'un hunk.
 *
 * Exemple d'utilisation :
 *   result.resolutions[0].hunk.trace.steps.forEach(s =>
 *     console.log(`[${s.passed ? '✅' : '❌'}] ${s.type}: ${s.reason}`)
 *   );
 */
export interface DecisionTrace {
  /** Étapes d'évaluation dans l'ordre d'exécution */
  steps: TraceStep[];
  /** Type finalement sélectionné */
  selected: ConflictType;
  /** Résumé en une ligne lisible */
  summary: string;
  /** La base (diff3) était-elle disponible ? Conditionne les vérifications fines */
  hasBase: boolean;
}

// ─── Phase v1.4 — Pattern Registry ──────────────────────────

/**
 * Input canonique pour la classification d'un hunk.
 * Identique à RawConflict (défini dans parser.ts comme alias de ce type).
 */
export interface ClassifyInput {
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
  startLine: number;
  endLine: number;
}

/** Résultat complet de la classification d'un hunk */
export interface ClassifyResult {
  type: ConflictType;
  confidence: ConfidenceScore;
  explanation: string;
  trace: DecisionTrace;
}

/**
 * Interface implémentée par chaque pattern du registre.
 *
 * - `priority` : ordre d'évaluation (plus petit = testé en premier)
 * - `requires` : diff3 (base disponible), diff2 (pas de base), both (toujours évalué)
 * - `detect`   : vrai si le pattern s'applique à ce hunk
 * - `confidence` : score composite quand le pattern a matché
 * - `explanation` : texte lisible pour l'UI (mode explain)
 * - `passReason` : raison dans la DecisionTrace quand passed=true
 * - `failReason` : raison dans la DecisionTrace quand passed=false
 */
export interface PatternPlugin {
  type: ConflictType;
  priority: number;
  requires: "diff3" | "diff2" | "both";
  detect(h: ClassifyInput): boolean;
  confidence(h: ClassifyInput): ConfidenceScore;
  explanation(h: ClassifyInput): string;
  passReason(h: ClassifyInput): string;
  failReason(h: ClassifyInput): string;
}

/** Un bloc (hunk) de différence identifié */
export interface ConflictHunk {
  /** Lignes dans la version base */
  baseLines: string[];
  /** Lignes dans la version ours */
  oursLines: string[];
  /** Lignes dans la version theirs */
  theirsLines: string[];
  /** Numéro de ligne de début dans le fichier original (base) */
  startLine: number;
  /** Type de conflit détecté */
  type: ConflictType;
  /** Score de confiance composite pour la résolution automatique */
  confidence: ConfidenceScore;
  /** Explication lisible de la résolution (pour l'audit) */
  explanation: string;
  /** Trace de la décision de classification (Phase 7.1) */
  trace: DecisionTrace;
  /**
   * v1.4 — Le conflit a-t-il été détecté en format zdiff3 ?
   * zdiff3 (Git 2.35+) produit une section base tronquée aux seules lignes divergentes.
   * Quand true, `baseAvailability` est fixé à 100 (même traitement que diff3).
   */
  zdiff3?: boolean;
}

/** Résultat de la résolution d'un seul hunk */
export interface HunkResolution {
  /** Le hunk d'origine */
  hunk: ConflictHunk;
  /** Les lignes résolues (null si non résolu) */
  resolvedLines: string[] | null;
  /** Est-ce que la résolution est automatique ? */
  autoResolved: boolean;
  /** Raison lisible de la résolution (ou du refus de résolution) */
  resolutionReason: string;
}

// ─── Phase 7.2 — Validation post-merge ───────────────────

/**
 * Résultat de la validation du contenu fusionné.
 * Détecte les problèmes résiduels après résolution.
 */
export interface ValidationResult {
  /** Des marqueurs de conflit résiduels ont-ils été détectés ? */
  hasResidualMarkers: boolean;
  /** Marqueurs trouvés (exemples, pas la liste exhaustive) */
  residualMarkerLines: number[];
  /** Erreur de syntaxe pour les fichiers structurés (JSON) — null si valide ou non applicable */
  syntaxError: string | null;
  /** Le contenu fusionné est-il valide ? */
  isValid: boolean;
}

/** Résultat complet de l'analyse et résolution d'un fichier */
export interface MergeResult {
  /** Chemin du fichier */
  filePath: string;
  /** Le fichier fusionné complet (null si des conflits restent) */
  mergedContent: string | null;
  /** Tous les hunks détectés */
  hunks: ConflictHunk[];
  /** Résolutions appliquées */
  resolutions: HunkResolution[];
  /** Statistiques */
  stats: MergeStats;
  /** Validation du contenu fusionné (Phase 7.2) */
  validation: ValidationResult;
}

/** Statistiques de résolution */
export interface MergeStats {
  /** Nombre total de conflits détectés */
  totalConflicts: number;
  /** Nombre de conflits résolus automatiquement */
  autoResolved: number;
  /** Nombre de conflits restants (nécessitent intervention) */
  remaining: number;
  /** Répartition par type */
  byType: Record<ConflictType, number>;
}

/** Options de configuration pour le moteur de résolution */
export interface GitWandOptions {
  /** Résoudre les conflits whitespace-only (défaut: true) */
  resolveWhitespace?: boolean;
  /** Résoudre les conflits d'imports non-overlapping (défaut: true) */
  resolveNonOverlapping?: boolean;
  /** Niveau de confiance minimum pour auto-résolution (défaut: "high") */
  minConfidence?: Confidence;
  /** Mode verbose pour le logging (défaut: false) */
  verbose?: boolean;
  /**
   * Mode dry-run : classifier et tracer les hunks mais ne pas appliquer de résolution.
   * Utile pour afficher le raisonnement sans toucher au fichier.
   * (Phase 7.1 — explain-only mode)
   */
  explainOnly?: boolean;
  /**
   * Politique de résolution automatique (Phase 7.4).
   * Contrôle les choix ambigus et le niveau d'agressivité.
   * - "prefer-ours"   : choix ambigus → ours
   * - "prefer-theirs" : choix ambigus → theirs (défaut du moteur)
   * - "prefer-merge"  : résoudre le plus possible (minConfidence: medium)
   * - "prefer-safety" : ne résoudre que l'évident (whitespace/value_only skippés)
   * - "strict"        : seulement same_change, one_side_change, delete_no_change
   */
  policy?: import("./config.js").MergePolicy;
  /**
   * Overrides de politique par pattern glob (Phase 7.4).
   * La clé est un pattern glob, la valeur une MergePolicy.
   * Exemple : `{ "*.lock": "prefer-theirs", "src/**\/*.ts": "prefer-ours" }`
   */
  patternOverrides?: Record<string, import("./config.js").MergePolicy>;
}
