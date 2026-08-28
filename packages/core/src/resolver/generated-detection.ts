/**
 * Détection des fichiers auto-générés (lockfiles, bundles, manifests…).
 *
 * Ces fichiers ne doivent pas être mergés ligne par ligne : le moteur les
 * reclassifie en `generated_file` et utilise `stripVolatileValues` pour
 * comparer les deux côtés modulo les valeurs volatiles (hashes, URLs,
 * timestamps). Extrait de `resolver.ts` lors du split P1.1.
 */

import type { ConflictHunk, ConfidenceScore, ConflictType } from "../types.js";
import { matchGlob } from "../config.js";

/** Patterns de fichiers auto-générés qui ne doivent pas être mergés ligne par ligne. */
export const GENERATED_FILE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /package-lock\.json$/i, label: "npm lockfile" },
  { pattern: /yarn\.lock$/i, label: "yarn lockfile" },
  { pattern: /pnpm-lock\.yaml$/i, label: "pnpm lockfile" },
  { pattern: /composer\.lock$/i, label: "composer lockfile" },
  { pattern: /Gemfile\.lock$/i, label: "bundler lockfile" },
  { pattern: /Cargo\.lock$/i, label: "cargo lockfile" },
  { pattern: /\.min\.(js|css)$/i, label: "minified file" },
  { pattern: /\bdist\//, label: "fichier build dist/" },
  { pattern: /\bbuild\/manifest\.json$/i, label: "manifest de build" },
  { pattern: /\.bundle\.(js|css)$/i, label: "bundle" },
  { pattern: /mix-manifest\.json$/i, label: "Laravel Mix manifest" },
];

/**
 * Retourne `generated: true` si le chemin correspond à un pattern auto-généré.
 *
 * Les `userGlobs` optionnels (P2.4) permettent d'étendre les built-ins avec des
 * patterns glob définis dans `.gitwandrc` (ex: `src/**\/*.generated.ts`, `*.pb.go`,
 * `api/openapi-client/**`). Les built-ins sont checkés en premier (plus rapide,
 * label descriptif) ; les user patterns ne sont évalués qu'en fallback.
 *
 * @param filePath - Chemin du fichier à tester
 * @param userGlobs - Patterns glob supplémentaires issus de la config projet
 */
export function isGeneratedFile(
  filePath: string,
  userGlobs?: readonly string[],
): { generated: boolean; label: string } {
  for (const { pattern, label } of GENERATED_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return { generated: true, label };
    }
  }
  if (userGlobs) {
    for (const glob of userGlobs) {
      if (matchGlob(glob, filePath)) {
        return { generated: true, label: `user pattern: ${glob}` };
      }
    }
  }
  return { generated: false, label: "" };
}

/**
 * Supprime les valeurs volatiles (hashes, timestamps, resolved URLs, integrity)
 * d'un bloc de lignes pour permettre une comparaison structurelle.
 * Utilisé pour détecter les conflits cosmétiques dans les fichiers générés.
 */
export function stripVolatileValues(lines: string[]): string {
  return lines
    .map((line) =>
      line
        // SHA/integrity hashes
        .replace(/sha[0-9]+-[A-Za-z0-9+/=]+/g, "<hash>")
        // npm resolved URLs with version+hash
        .replace(/"resolved":\s*"[^"]+"/g, '"resolved": "<url>"')
        // integrity fields
        .replace(/"integrity":\s*"[^"]+"/g, '"integrity": "<hash>"')
        // Generic hex hashes (7+ chars)
        .replace(/\b[a-f0-9]{7,64}\b/g, "<hex>")
        // ISO timestamps
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
        // Semver with build metadata
        .replace(/\d+\.\d+\.\d+[-+][A-Za-z0-9.]+/g, "<ver>")
    )
    .join("\n");
}

/**
 * Reclassifie un hunk `complex` en `generated_file` lorsque le chemin
 * correspond à un pattern auto-généré. Retourne une copie du hunk avec
 * le type, la confiance, l'explication et la trace mis à jour.
 *
 * Si le hunk n'est pas `complex` ou si le fichier n'est pas auto-généré,
 * le hunk est retourné tel quel.
 */
export function reclassifyIfGenerated(
  hunk: ConflictHunk,
  genInfo: { generated: boolean; label: string },
): ConflictHunk {
  if (!genInfo.generated || hunk.type !== "complex") {
    return hunk;
  }

  const generatedScore: ConfidenceScore = {
    score: 72,
    label: "high",
    dimensions: {
      typeClassification: 90,
      dataRisk: 30,
      scopeImpact: 15,
      fileFrequency: 0,
      baseAvailability: 0,
    },
    boosters: [`Path matches the generated-file pattern: ${genInfo.label}`],
    penalties: ["The content will be regenerated, so theirs is assumed to be the more recent"],
  };

  return {
    ...hunk,
    type: "generated_file",
    confidence: generatedScore,
    explanation: `Generated file (${genInfo.label}). It will be rebuilt after the merge. Proposed resolution: take theirs and re-run the build.`,
    // Update the trace to reflect the reclassification
    trace: {
      ...hunk.trace,
      selected: "generated_file",
      summary: `Generated file (${genInfo.label}), reclassified out of complex.`,
      steps: [
        ...hunk.trace.steps.slice(0, -1), // remove the "complex passed: true" step
        {
          type: "complex" as ConflictType,
          passed: false,
          reason: `Reclassified: generated file (${genInfo.label}) detected by its path.`,
        },
        {
          type: "generated_file" as ConflictType,
          passed: true,
          reason: `Path matches the generated-file pattern: ${genInfo.label}.`,
        },
      ],
    },
  };
}
