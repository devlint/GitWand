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

    return result;
  } catch {
    return null;
  }
}
