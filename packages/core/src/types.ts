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
  | "complex";              // Conflit réel nécessitant intervention humaine

/** Niveau de confiance de la résolution */
export type Confidence = "certain" | "high" | "medium" | "low";

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
}

/** Résultat de la résolution d'un seul hunk */
export interface HunkResolution {
  /** Le hunk d'origine */
  hunk: ConflictHunk;
  /** Les lignes résolues (null si non résolu) */
  resolvedLines: string[] | null;
  /** Est-ce que la résolution est automatique ? */
  autoResolved: boolean;
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
}
