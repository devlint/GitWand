/**
 * GitWand — Politiques de merge et configuration par projet
 *
 * Phase 7.4 : stratégies configurables, .gitwandrc, overrides par pattern glob.
 *
 * ## Politiques disponibles
 *
 * | Politique       | Usage typique                                 |
 * |-----------------|-----------------------------------------------|
 * | `prefer-ours`   | Monorepo — protéger les changements locaux    |
 * | `prefer-theirs` | Intégration continue — accepter l'upstream    |
 * | `prefer-merge`  | Développement actif — résoudre le plus possible (défaut) |
 * | `prefer-safety` | Code sensible — ne résoudre que l'évident     |
 * | `strict`        | Release branch — seulement le trivial         |
 *
 * ## Choix implicites du moteur textuel (documentation des conventions)
 *
 * - `whitespace_only` → **ours** (préserver l'indentation locale)
 * - `value_only_change` → **theirs** (les valeurs volatiles — hash, versions — viennent du merge)
 * - `generated_file` → **theirs** (le fichier sera régénéré, theirs est plus récent)
 * - `one_side_change` → la branche modifiée (logique de préservation du changement)
 * - `non_overlapping` → merge LCS (les deux changements coexistent)
 * - `complex` → **pas de résolution automatique** (risque trop élevé)
 *
 * ## Format .gitwandrc
 * ```json
 * {
 *   "policy": "prefer-safety",
 *   "patterns": {
 *     "*.lock": "prefer-theirs",
 *     "package.json": "prefer-theirs",
 *     "src/**\/*.ts": "prefer-ours"
 *   }
 * }
 * ```
 * Ou dans `package.json` sous la clé `"gitwand"`.
 */

// ─── ValidationLevel ──────────────────────────────────────

/**
 * Niveau de validation post-merge.
 *
 * | Niveau      | Ce qui est vérifié                                                        |
 * |-------------|---------------------------------------------------------------------------|
 * | `balanced`  | Marqueurs résiduels + syntaxe JSON/YAML/TOML + parse-tree tree-sitter     |
 * | `strict`    | Balanced + `tsc --noEmit` et/ou `eslint` (Node.js uniquement, opt-in)    |
 * | `off`       | Aucune validation post-merge (performances max, risque accru)             |
 */
export type ValidationLevel = "balanced" | "strict" | "off";

// ─── MergePolicy ─────────────────────────────────────────

/**
 * Politique de résolution automatique des conflits.
 */
export type MergePolicy =
  | "prefer-ours"    // choix ambigus → ours ; minConfidence: high
  | "prefer-theirs"  // choix ambigus → theirs (comportement par défaut du moteur)
  | "prefer-merge"   // résoudre le plus possible ; minConfidence abaissé à "medium"
  | "prefer-safety"  // ne résoudre que si très sûr ; whitespace et value_only skippés
  | "strict";        // seulement same_change, one_side_change, delete_no_change

// ─── PolicyConfig ─────────────────────────────────────────

/**
 * Configuration dérivée d'une `MergePolicy`.
 * Utilisée en interne par `resolveHunk` pour appliquer la politique.
 */
export interface PolicyConfig {
  /** Pour les types ambigus (whitespace_only, value_only_change) : prendre ours ou theirs ? */
  preferOurs: boolean;
  /** Résoudre les conflits `whitespace_only` ? */
  allowWhitespace: boolean;
  /** Résoudre les conflits `value_only_change` ? */
  allowValueOnly: boolean;
  /** Résoudre les conflits `non_overlapping` ? */
  allowNonOverlapping: boolean;
  /** Seuil de confiance effectif (override du paramètre global) */
  minConfidence: "certain" | "high" | "medium" | "low";
}

/** Convertit une `MergePolicy` en `PolicyConfig` exploitable. */
export function policyToConfig(policy: MergePolicy): PolicyConfig {
  switch (policy) {
    case "prefer-ours":
      return {
        preferOurs: true,
        allowWhitespace: true,
        allowValueOnly: true,
        allowNonOverlapping: true,
        minConfidence: "high",
      };
    case "prefer-theirs":
      return {
        preferOurs: false,
        allowWhitespace: true,
        allowValueOnly: true,
        allowNonOverlapping: true,
        minConfidence: "high",
      };
    case "prefer-merge":
      return {
        preferOurs: false,
        allowWhitespace: true,
        allowValueOnly: true,
        allowNonOverlapping: true,
        minConfidence: "medium",  // plus permissif
      };
    case "prefer-safety":
      return {
        preferOurs: false,
        allowWhitespace: false,  // skip whitespace (risque d'indentation)
        allowValueOnly: false,   // skip value_only (valeurs sensibles)
        allowNonOverlapping: true,
        minConfidence: "high",
      };
    case "strict":
      return {
        preferOurs: false,
        allowWhitespace: false,
        allowValueOnly: false,
        allowNonOverlapping: false,  // pas de merge LCS automatique
        minConfidence: "high",
      };
  }
}

/** Politique par défaut (comportement historique du moteur) */
export const DEFAULT_POLICY: MergePolicy = "prefer-theirs";

// ─── Glob matching ────────────────────────────────────────

/**
 * Implémentation minimale de pattern glob pour les overrides de fichiers.
 *
 * Supporte :
 * - `*`  — n'importe quel caractère sauf `/`
 * - `**` — n'importe quel caractère (y compris `/`)
 * - `?`  — exactement un caractère sauf `/`
 * - Correspondance sur le basename si le pattern ne contient pas de `/`
 *
 * @param pattern - Motif glob (ex: `*.lock`, `src/**\/*.ts`, `package.json`)
 * @param filePath - Chemin du fichier (ex: `src/utils/helper.ts`)
 * @returns `true` si le chemin correspond au motif
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // Normaliser les séparateurs de chemin
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // Si le pattern ne contient pas de /, correspondre sur le basename
  if (!normalizedPattern.includes("/")) {
    const basename = normalizedPath.split("/").pop() ?? normalizedPath;
    return globRegex(normalizedPattern).test(basename);
  }

  // Correspondance sur le chemin complet
  return globRegex(normalizedPattern).test(normalizedPath);
}

/** Convertit un pattern glob en RegExp. */
function globRegex(pattern: string): RegExp {
  // Échapper les caractères spéciaux regex, puis replacer les globs
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // échapper les caractères regex
    .replace(/\*\*/g, "§DSTAR§")            // placeholder pour **
    .replace(/\*/g, "[^/]*")               // * → tout sauf /
    .replace(/\?/g, "[^/]")                // ? → un char sauf /
    .replace(/§DSTAR§/g, ".*");            // ** → tout (y compris /)

  return new RegExp(`^${escaped}$`);
}

// ─── Effective policy ─────────────────────────────────────

/**
 * Détermine la politique effective pour un fichier donné.
 *
 * Priorité :
 * 1. Pattern override le plus spécifique (par longueur de pattern)
 * 2. Politique globale
 * 3. Politique par défaut (`"prefer-theirs"`)
 *
 * @param filePath - Chemin du fichier
 * @param globalPolicy - Politique globale (depuis .gitwandrc ou options)
 * @param patternOverrides - Map pattern → politique
 */
export function effectivePolicyForFile(
  filePath: string,
  globalPolicy?: MergePolicy,
  patternOverrides?: Record<string, MergePolicy>,
): MergePolicy {
  if (patternOverrides) {
    // Trouver tous les patterns qui matchent, prendre le plus spécifique (plus long)
    const matches: Array<{ pattern: string; policy: MergePolicy }> = [];

    for (const [pattern, policy] of Object.entries(patternOverrides)) {
      if (matchGlob(pattern, filePath)) {
        matches.push({ pattern, policy });
      }
    }

    if (matches.length > 0) {
      // Pattern le plus spécifique = le plus long
      matches.sort((a, b) => b.pattern.length - a.pattern.length);
      return matches[0].policy;
    }
  }

  return globalPolicy ?? DEFAULT_POLICY;
}

// ─── .gitwandrc config ────────────────────────────────────

/**
 * Structure du fichier `.gitwandrc` ou de la clé `"gitwand"` dans `package.json`.
 */
export interface GitWandrcConfig {
  /** Politique de merge globale */
  policy?: MergePolicy;
  /** Overrides par pattern glob */
  patterns?: Record<string, MergePolicy>;
  /**
   * Patterns glob supplémentaires pour fichiers auto-générés (P2.4).
   * S'ajoutent aux built-ins (lockfiles, bundles, `dist/`…) sans les remplacer.
   */
  generatedFiles?: string[];
  /**
   * v2.4 — Validation post-merge.
   * - `level: "balanced"` (défaut) : marqueurs résiduels + syntaxe + parse-tree
   * - `level: "strict"` : + tsc --noEmit et/ou eslint (Node.js uniquement, opt-in)
   * - `level: "off"` : désactive toute validation post-merge
   *
   * ```json
   * { "validation": { "level": "strict", "tools": ["tsc", "eslint"] } }
   * ```
   */
  validation?: {
    level?: ValidationLevel;
    /** Outils externes activés en mode strict. Défaut : ["tsc"]. */
    tools?: Array<"tsc" | "eslint">;
  };
  /**
   * v2.5 — Configuration du fallback LLM (sans le champ `endpoint`, injecté programmatiquement).
   *
   * Le champ `endpoint` de `LlmFallbackConfig` ne peut pas être sérialisé dans un fichier JSON.
   * Il doit être injecté via `GitWandOptions.llmFallback.endpoint` dans le code consommateur.
   *
   * ```jsonc
   * {
   *   "llmFallback": {
   *     "enabled": false,
   *     "model": "claude-sonnet-4-6",
   *     "maxTokens": 4000,
   *     "temperature": 0.0,
   *     "contextLines": 50,
   *     "minPostMergeScore": 80,
   *     "minMode": "strict"
   *   }
   * }
   * ```
   */
  llmFallback?: {
    enabled?: boolean;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    contextLines?: number;
    minPostMergeScore?: number;
    minMode?: ValidationLevel;
  };
  /**
   * v2.6 — Moteur RefMerge (expérimental, opt-in).
   *
   * ```jsonc
   * {
   *   "refactoringAware": {
   *     "enabled": true,
   *     "maxRefactoringsPerSide": 10
   *   }
   * }
   * ```
   */
  refactoringAware?: {
    /** Activer le moteur RefMerge (défaut: false) */
    enabled?: boolean;
    /**
     * Nombre maximum de refactorings par branche avant fallback `complex`. Défaut: 10.
     */
    maxRefactoringsPerSide?: number;
  };
  /**
   * v3.5.0 — Scanner de secrets sur les lignes ajoutées en staging.
   *
   * ```jsonc
   * {
   *   "secrets": {
   *     "enabled": true,
   *     "patterns": [
   *       { "id": "internal_token", "regex": "itok_[0-9a-f]{32}", "severity": "high" }
   *     ],
   *     "ignore": ["fixtures/**", "/AKIAFAKEFAKEFAKEFAKE/"],
   *     "entropyThreshold": 4.0
   *   }
   * }
   * ```
   */
  secrets?: {
    /** Master switch, combiné au setting applicatif `secretsScannerEnabled` (défaut: true). */
    enabled?: boolean;
    /** Patterns supplémentaires, en plus du catalogue built-in. */
    patterns?: Array<{
      id: string;
      regex: string;
      severity: "high" | "medium" | "low";
      description: string;
    }>;
    /** Glob de chemin OU littéral `/regex/` sur la valeur matchée. */
    ignore?: string[];
    /** Seuil d'entropie Shannon (bits/char) pour la détection de secrets à haute entropie, [0, 8]. 0 désactive. */
    entropyThreshold?: number;
  };
}

/**
 * Parse une configuration GitWandrc depuis une string JSON.
 * Retourne `null` en cas d'erreur de parsing.
 */
export function parseGitwandrc(json: string): GitWandrcConfig | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;

    const result: GitWandrcConfig = {};

    // Valider la politique
    const validPolicies: MergePolicy[] = [
      "prefer-ours",
      "prefer-theirs",
      "prefer-merge",
      "prefer-safety",
      "strict",
    ];
    if (parsed.policy && validPolicies.includes(parsed.policy)) {
      result.policy = parsed.policy;
    }

    // Valider les patterns
    if (parsed.patterns && typeof parsed.patterns === "object") {
      const patterns: Record<string, MergePolicy> = {};
      for (const [pattern, policyRaw] of Object.entries(parsed.patterns)) {
        if (typeof policyRaw === "string" && validPolicies.includes(policyRaw as MergePolicy)) {
          patterns[pattern] = policyRaw as MergePolicy;
        }
      }
      if (Object.keys(patterns).length > 0) {
        result.patterns = patterns;
      }
    }

    // Valider les patterns de fichiers auto-générés (P2.4).
    // On accepte un tableau de strings non vides ; on skip tout ce qui n'est pas
    // une string pour rester tolérant aux configs « presque valides ».
    if (Array.isArray(parsed.generatedFiles)) {
      const generatedFiles = parsed.generatedFiles.filter(
        (p: unknown): p is string => typeof p === "string" && p.length > 0,
      );
      if (generatedFiles.length > 0) {
        result.generatedFiles = generatedFiles;
      }
    }

    // v2.4 — Validation post-merge.
    const validLevels: ValidationLevel[] = ["balanced", "strict", "off"];
    if (parsed.validation && typeof parsed.validation === "object") {
      const validTools = ["tsc", "eslint"] as const;
      const val: GitWandrcConfig["validation"] = {};

      if (validLevels.includes(parsed.validation.level)) {
        val.level = parsed.validation.level as ValidationLevel;
      }
      if (Array.isArray(parsed.validation.tools)) {
        const tools = parsed.validation.tools.filter(
          (t: unknown): t is "tsc" | "eslint" =>
            typeof t === "string" && (validTools as readonly string[]).includes(t),
        );
        if (tools.length > 0) val.tools = tools;
      }
      if (Object.keys(val).length > 0) {
        result.validation = val;
      }
    }

    // v2.5 — LLM fallback config (sans endpoint, injecté programmatiquement).
    if (parsed.llmFallback && typeof parsed.llmFallback === "object") {
      const llm = parsed.llmFallback;
      const fallback: NonNullable<GitWandrcConfig["llmFallback"]> = {};

      if (typeof llm.enabled === "boolean") fallback.enabled = llm.enabled;
      if (typeof llm.model === "string" && llm.model.length > 0) fallback.model = llm.model;
      if (typeof llm.maxTokens === "number" && llm.maxTokens > 0) fallback.maxTokens = llm.maxTokens;
      if (typeof llm.temperature === "number" && llm.temperature >= 0 && llm.temperature <= 2) {
        fallback.temperature = llm.temperature;
      }
      if (typeof llm.contextLines === "number" && llm.contextLines > 0) {
        fallback.contextLines = llm.contextLines;
      }
      if (typeof llm.minPostMergeScore === "number" && llm.minPostMergeScore >= 0 && llm.minPostMergeScore <= 100) {
        fallback.minPostMergeScore = llm.minPostMergeScore;
      }
      if (validLevels.includes(llm.minMode)) fallback.minMode = llm.minMode as ValidationLevel;

      if (Object.keys(fallback).length > 0) {
        result.llmFallback = fallback;
      }
    }

    // v2.6 — RefMerge config (expérimental, opt-in).
    if (parsed.refactoringAware && typeof parsed.refactoringAware === "object") {
      const ra = parsed.refactoringAware;
      const refactoringAware: NonNullable<GitWandrcConfig["refactoringAware"]> = {};

      if (typeof ra.enabled === "boolean") refactoringAware.enabled = ra.enabled;
      if (typeof ra.maxRefactoringsPerSide === "number" && ra.maxRefactoringsPerSide > 0) {
        refactoringAware.maxRefactoringsPerSide = ra.maxRefactoringsPerSide;
      }

      if (Object.keys(refactoringAware).length > 0) {
        result.refactoringAware = refactoringAware;
      }
    }

    // v3.5.0 — Secrets scanner config.
    if (parsed.secrets && typeof parsed.secrets === "object") {
      const sec = parsed.secrets;
      const secrets: NonNullable<GitWandrcConfig["secrets"]> = {};

      if (typeof sec.enabled === "boolean") secrets.enabled = sec.enabled;

      if (Array.isArray(sec.patterns)) {
        const validSeverities = ["high", "medium", "low"] as const;
        const patterns = sec.patterns
          .filter(
            (p: unknown): p is { id: string; regex: string; severity?: string; description?: string } =>
              typeof p === "object" &&
              p !== null &&
              typeof (p as Record<string, unknown>).id === "string" &&
              (p as Record<string, unknown>).id !== "" &&
              typeof (p as Record<string, unknown>).regex === "string",
          )
          .map((p) => ({
            id: p.id,
            regex: p.regex,
            severity: (validSeverities as readonly string[]).includes(p.severity ?? "")
              ? (p.severity as "high" | "medium" | "low")
              : ("medium" as const),
            description: typeof p.description === "string" ? p.description : "",
          }));
        if (patterns.length > 0) secrets.patterns = patterns;
      }

      if (Array.isArray(sec.ignore)) {
        const ignore = sec.ignore.filter(
          (i: unknown): i is string => typeof i === "string" && i.length > 0,
        );
        if (ignore.length > 0) secrets.ignore = ignore;
      }

      if (
        typeof sec.entropyThreshold === "number" &&
        sec.entropyThreshold >= 0 &&
        sec.entropyThreshold <= 8
      ) {
        secrets.entropyThreshold = sec.entropyThreshold;
      }

      if (Object.keys(secrets).length > 0) {
        result.secrets = secrets;
      }
    }

    return result;
  } catch {
    return null;
  }
}
