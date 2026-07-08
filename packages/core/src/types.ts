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
  | "token_level_merge"        // v2.7 — fusion fine ligne/token, toujours proposée (jamais auto-appliquée)
  | "llm_proposed"              // v2.5 — résolution proposée par LLM fallback (opt-in, priority 998)
  | "refactoring_aware_merge"  // v2.6 — RefMerge : détection/inversion/rejeu de refactorings (expérimental, opt-in)
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
 * Formule v2.4 :
 *   `score = typeClassification
 *           − dataRisk        × 0.40
 *           − scopeImpact     × 0.15
 *           − fileFrequency   × 0.10
 *           + baseAvailability × 0.05
 *           − algorithmStability × 0.10
 *           − postMergeRisk   × 0.20`
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
    /**
     * v2.1 — Pénalité « instabilité algorithmique » : 0 = pas de signal, 100 =
     * refactoring massif détecté des deux côtés (block-moves majoritaires).
     * Optionnel pour rétro-compat — les patterns qui ne la set pas voient
     * `undefined`. Consommée par `makeScore` avec un poids de −0.10.
     *
     * Alimentée à terme par `detectBlockMove` (primitive livrée en v2.1,
     * branchement scoring repoussé à v2.6 refactoring-aware merge où le signal
     * devient actionnable). En v2.1 la dimension existe et est modélisée, mais
     * aucun pattern ne la set encore — le score reste numériquement identique
     * pour la rétro-compat stricte.
     */
    algorithmStability?: number;
    /**
     * v2.4 — Risque post-merge détecté par validation parse-tree (tree-sitter).
     * 0 = parse tree valide, 100 = erreurs de syntaxe détectées après résolution.
     * Optionnel — uniquement set quand la validation parse-tree est exécutée et échoue.
     * Lorsque non nul, la résolution est rétractée (hunk remis en marqueurs de conflit).
     */
    postMergeRisk?: number;
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

// ─── v2.5 — LLM fallback ──────────────────────────────────

/**
 * v2.5 — Endpoint LLM injecté par le consommateur.
 *
 * `@gitwand/core` n'effectue jamais de requête HTTP directe.
 * C'est le consommateur (CLI, desktop, extension) qui fournit
 * cette interface et décide du transport (API, MCP, Ollama local…).
 *
 * Exemple d'implémentation dans le CLI :
 * ```ts
 * const endpoint: LlmEndpoint = {
 *   async call(prompt) {
 *     return myAnthropicClient.complete(prompt);
 *   }
 * };
 * ```
 */
export interface LlmEndpoint {
  /**
   * Appelle le LLM avec un prompt structuré et retourne la réponse textuelle.
   * @param prompt - Prompt complet (hunk sérialisé + contexte + instructions)
   * @returns Résolution proposée par le LLM (texte brut, lignes de code)
   */
  call(prompt: string): Promise<string>;
}

/**
 * v2.5 — Configuration du fallback LLM.
 *
 * Placée dans `GitWandOptions.llmFallback` ou parsée depuis `.gitwandrc`.
 * Le champ `endpoint` est injecté programmatiquement (non sérialisable).
 */
export interface LlmFallbackConfig {
  /**
   * Active le fallback LLM pour les hunks complexes non résolus.
   * Défaut : `false`. Doit être explicitement opté.
   */
  enabled: boolean;
  /**
   * Endpoint LLM injecté par le consommateur.
   * Requis si `enabled: true` — sans lui, le fallback est silencieusement skippé.
   * Non présent dans `.gitwandrc` (injecté programmatiquement).
   */
  endpoint?: LlmEndpoint;
  /**
   * Nom du modèle (hint informatif, passé à l'endpoint par le consommateur).
   * Défaut : `"claude-sonnet-4-6"`.
   */
  model?: string;
  /**
   * Nombre maximum de tokens dans la réponse LLM.
   * Défaut : `4000`.
   */
  maxTokens?: number;
  /**
   * Température pour l'appel LLM (0.0 = déterministe).
   * Défaut : `0.0` — reproductibilité recommandée.
   */
  temperature?: number;
  /**
   * Nombre de lignes de contexte autour du hunk incluses dans le prompt.
   * Défaut : `50`.
   */
  contextLines?: number;
  /**
   * Score de validation post-merge minimum (0–100) pour accepter la résolution LLM.
   * Sous ce seuil, la résolution est refusée et le hunk reste `complex`.
   * Défaut : `80`.
   */
  minPostMergeScore?: number;
  /**
   * Niveau de validation imposé pour les résolutions LLM.
   * Recommandation forte : garder `"strict"` (tsc + eslint) pour limiter les hallucinations.
   * Défaut : `"strict"`.
   */
  minMode?: import("./config.js").ValidationLevel;
}

/**
 * v2.5 — Trace d'un appel LLM dans la DecisionTrace.
 * Produite uniquement quand `llm_proposed` est le type sélectionné.
 *
 * Audit trail complet pour la traçabilité et la reproductibilité.
 */
export interface LlmTrace {
  /** Horodatage ISO 8601 de l'appel LLM */
  calledAt: string;
  /** Modèle invoqué (tel que renvoyé par l'endpoint ou fourni dans la config) */
  model: string;
  /** Latence en millisecondes (temps entre envoi du prompt et réception de la réponse) */
  latencyMs: number;
  /** Hash SHA-256 du prompt (hex, pour audit de reproductibilité) */
  promptHash: string;
  /** Réponse brute tronquée (500 premiers caractères, pour debug sans exposer le code) */
  rawResponseTruncated: string;
  /** Score de validation post-merge obtenu (0–100) */
  validationScore: number;
  /** La résolution LLM a-t-elle été acceptée ? (`false` = fallback sur `complex`) */
  accepted: boolean;
}

// ─── Phase v2.6 — Refactoring-aware merge ────────────────────

/**
 * v2.6 — Catégories de refactoring détectables par le moteur RefMerge.
 *
 * | Kind               | Description                                                      |
 * |--------------------|------------------------------------------------------------------|
 * | `rename-local`     | Variable ou paramètre renommé uniformément dans une fonction     |
 * | `rename-top-level` | Fonction ou classe renommée + tous ses usages mis à jour         |
 * | `move-method`      | Méthode déplacée d'une classe vers une autre                     |
 */
export type RefactoringKind =
  | "rename-local"       // variable/param renommée uniformément dans une fonction
  | "rename-top-level"   // fonction/classe renommée + usages mis à jour
  | "move-method";       // méthode déplacée d'une classe vers une autre

/**
 * v2.6 — Un refactoring détecté entre la base et une branche.
 *
 * Produit par `detectRefactorings()` dans `src/refactoring/detect.ts`.
 * Consommé par `invertRefactorings()` et `replayRefactorings()`.
 */
export interface Refactoring {
  kind: RefactoringKind;
  /** Ancien nom du symbole (avant refactoring) */
  oldName: string;
  /** Nouveau nom du symbole — défini pour `rename-local` et `rename-top-level` */
  newName?: string;
  /** Pour `move-method` : classe d'origine du symbole */
  sourceClass?: string;
  /** Pour `move-method` : classe de destination du symbole */
  targetClass?: string;
  /**
   * Portée lexicale du refactoring.
   * Pour `rename-local` : nom de la fonction parente.
   * Non défini pour les refactorings top-level.
   */
  scope?: string;
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
  /**
   * v2.5 — Trace de l'appel LLM (uniquement si `selected === "llm_proposed"`).
   * `undefined` pour tous les autres types de conflit.
   */
  llmTrace?: LlmTrace;
  /**
   * v2.7 — Proposition de fusion token-level (uniquement si
   * `selected === "token_level_merge"`). `undefined` pour tous les autres types.
   */
  tokenMergeTrace?: TokenMergeTrace;
}

// ─── v2.7 — Token-level merge (proposition, jamais auto-appliquée) ──────

/** Détail de résolution pour une ligne du hunk. */
export interface TokenMergeLineDetail {
  /** Index de la ligne dans le hunk (0-based, aligné sur base/ours/theirs). */
  lineIndex: number;
  /** Quelle passe a résolu cette ligne. */
  resolvedBy: "pass1" | "pass2";
  /** Contenu final proposé pour cette ligne. */
  resolvedLine: string;
  /** Indices de tokens modifiés par ours (uniquement renseigné pour pass2). */
  oursTokenIndices?: number[];
  /** Indices de tokens modifiés par theirs (uniquement renseigné pour pass2). */
  theirsTokenIndices?: number[];
}

/** Proposition complète de fusion token-level pour un hunk. */
export interface TokenMergeTrace {
  /** Lignes fusionnées proposées — appliquées telles quelles si l'utilisateur accepte. */
  mergedLines: string[];
  /** Nombre de lignes résolues par la passe 1 (décomposition ligne-par-ligne). */
  pass1Count: number;
  /** Nombre de lignes résolues par la passe 2 (diff token-level). */
  pass2Count: number;
  /** Détail par ligne, pour l'annotation visuelle dans le panneau de proposition. */
  lineDetails: TokenMergeLineDetail[];
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
 * v2.4 — Résultat d'une validation externe (tsc --noEmit / eslint).
 */
export interface ExternalValidationResult {
  /** Outil de validation utilisé */
  tool: "tsc" | "eslint";
  /** Messages d'erreur remontés par l'outil */
  errors: string[];
  /** `true` si aucune erreur remontée */
  passed: boolean;
}

/**
 * Résultat de la validation du contenu fusionné.
 * Détecte les problèmes résiduels après résolution.
 */
export interface ValidationResult {
  /** Des marqueurs de conflit résiduels ont-ils été détectés ? */
  hasResidualMarkers: boolean;
  /** Marqueurs trouvés (exemples, pas la liste exhaustive) */
  residualMarkerLines: number[];
  /** Erreur de syntaxe pour les fichiers structurés (JSON/YAML/TOML) — null si valide ou non applicable */
  syntaxError: string | null;
  /** Le contenu fusionné est-il valide ? */
  isValid: boolean;
  /**
   * v2.4 — Résultat de la validation parse-tree via tree-sitter.
   * - `true`  : l'arbre syntaxique ne contient aucun nœud d'erreur
   * - `false` : des erreurs syntaxiques ont été détectées → rétraction activée
   * - `null`  : non évalué (sync, langage non supporté, ou web-tree-sitter absent)
   */
  parseTreeValid?: boolean | null;
  /**
   * v2.4 — Nombre de nœuds ERROR dans l'arbre syntaxique (0 si aucun ou non évalué).
   */
  parseTreeErrors?: number;
  /**
   * v2.4 — Positions des nœuds ERROR dans le contenu fusionné.
   * Vide si aucune erreur ou si la validation parse-tree n'a pas été exécutée.
   */
  parseTreeErrorRanges?: Array<{ start: number; end: number }>;
  /**
   * v2.4 — Résultat de la validation stricte (tsc --noEmit / eslint).
   * `null` si la validation stricte n'a pas été activée.
   * Opt-in via `.gitwandrc` `validation.level: "strict"`.
   */
  externalValidation?: ExternalValidationResult | null;
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
  /**
   * Patterns glob de fichiers auto-générés (P2.4).
   * S'ajoutent aux built-ins (lockfiles, bundles, `dist/`…) sans les remplacer.
   * Exemple : `["src/**\/*.generated.ts", "*.pb.go", "api/openapi-client/**"]`.
   */
  generatedFiles?: string[];
  /**
   * v2.4 — Niveau de validation post-merge.
   * - `"balanced"` (défaut) : marqueurs résiduels + syntaxe JSON/YAML/TOML + parse-tree tree-sitter (async)
   * - `"strict"` : + tsc --noEmit et/ou eslint (opt-in, Node.js uniquement)
   * - `"off"` : désactive toute validation post-merge
   */
  validationLevel?: import("./config.js").ValidationLevel;
  /**
   * v2.4 — Outils externes utilisés en mode `validationLevel: "strict"`.
   * Défaut : `["tsc"]`. Ignoré si `validationLevel !== "strict"`.
   */
  validationTools?: Array<"tsc" | "eslint">;
  /**
   * v2.2 — Désactive globalement les FormatProfile.
   *
   * Quand `true`, les résolveurs JSON et YAML sautent le lookup `profileForFile`
   * et se comportent exactement comme en v2.1 (les arrays modifiés des deux
   * côtés retombent en fallback textuel). Utile pour rollback ponctuel,
   * debug d'un profil mal calibré, ou scénarios où un profil tiers introduit
   * des suppressions silencieuses inattendues.
   *
   * Défaut: `false` (profils actifs).
   */
  disableFormatProfiles?: boolean;
  /**
   * v2.5 — Configuration du fallback LLM pour les hunks `complex` non résolus.
   *
   * Désactivé par défaut (`enabled: false`). Pour activer, fournir également
   * un `endpoint` qui implémente `LlmEndpoint.call(prompt)`.
   *
   * N'a d'effet qu'avec `resolveAsync()` — `resolve()` synchrone ignore cette option
   * (avec un warning si `verbose: true`).
   *
   * ```ts
   * await resolveAsync(content, filePath, {
   *   llmFallback: {
   *     enabled: true,
   *     endpoint: { call: async (p) => myLlmClient.complete(p) },
   *     minPostMergeScore: 80,
   *   }
   * });
   * ```
   */
  llmFallback?: LlmFallbackConfig;
  /**
   * v2.6 — Moteur de résolution RefMerge (expérimental, opt-in).
   *
   * Quand activé, le moteur tente de détecter les refactorings (rename, move-method)
   * entre la base et chaque branche avant de lancer la résolution textuelle classique.
   * Les refactorings détectés sont inversés, le merge textuel est appliqué, puis les
   * refactorings sont rejoués sur le résultat.
   *
   * Désactivé par défaut (`enabled: false`).
   *
   * ```ts
   * await resolveAsync(content, filePath, {
   *   refactoringAware: { enabled: true, maxRefactoringsPerSide: 5 }
   * });
   * ```
   */
  refactoringAware?: {
    /** Activer le moteur RefMerge (défaut: false) */
    enabled?: boolean;
    /**
     * Nombre maximum de refactorings détectés par branche (ours/theirs).
     * Au-delà, le hunk tombe en fallback `complex`. Défaut: 10.
     */
    maxRefactoringsPerSide?: number;
  };
}
