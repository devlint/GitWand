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
  | "one_side_change"       // Seul un côté a modifié par rapport à la base
  | "same_change"           // Les deux côtés ont fait la même modification
  | "non_overlapping"       // Ajouts à des endroits différents (ex: imports)
  | "whitespace_only"       // Différences de whitespace uniquement
  | "delete_no_change"      // Un côté supprime, l'autre n'a pas touché
  | "generated_file"        // Fichier auto-généré (lock, manifest, min.js…)
  | "value_only_change"     // Même structure, seule une valeur change (hash, version, timestamp…)
  | "complex";              // Conflit réel nécessitant intervention humaine

/** Niveau de confiance de la résolution */
export type Confidence = "certain" | "high" | "medium" | "low";

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
  /** Niveau de confiance pour la résolution automatique */
  confidence: Confidence;
  /** Explication lisible de la résolution (pour l'audit) */
  explanation: string;
  /** Trace de la décision de classification (Phase 7.1) */
  trace: DecisionTrace;
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
}
