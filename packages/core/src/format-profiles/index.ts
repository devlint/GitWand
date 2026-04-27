/**
 * GitWand — Registre de profils de format
 *
 * Le registre centralise les FormatProfile reconnus. Les consommateurs
 * (tryResolveJsonConflict, tryResolveYamlConflict) appellent profileForFile()
 * pour obtenir, le cas échéant, un profil applicable au filePath courant.
 *
 * Les profils sont essayés dans l'ordre d'enregistrement — le premier dont
 * matches(filePath) retourne true gagne. Les built-ins sont enregistrés ici ;
 * les consommateurs externes peuvent ajouter les leurs via registerFormatProfile.
 */

import type { FormatProfile, PathStrategy } from "./types.js";
import { packageJsonProfile } from "./profiles/package-json.js";
import { tsconfigProfile } from "./profiles/tsconfig.js";
import { composerProfile } from "./profiles/composer.js";
import { helmValuesProfile } from "./profiles/helm-values.js";
import { kubernetesProfile } from "./profiles/kubernetes.js";

const PROFILES: FormatProfile[] = [
  packageJsonProfile,
  tsconfigProfile,
  composerProfile,
  // YAML profiles : helm avant kubernetes (helm/values.yaml peut matcher les
  // deux, on veut le plus spécifique en premier).
  helmValuesProfile,
  kubernetesProfile,
];

/**
 * Cherche un profil applicable au filePath. Retourne null si aucun match.
 */
export function profileForFile(filePath: string): FormatProfile | null {
  for (const profile of PROFILES) {
    if (profile.matches(filePath)) return profile;
  }
  return null;
}

/**
 * Enregistre un profil custom. Inséré en tête (priorité sur les built-ins
 * pour les filePath qu'il match), pratique pour qu'une extension VS Code ou
 * un consommateur monorepo override un built-in.
 *
 * @returns une fonction d'unregister (pour cleanup propre dans les tests).
 */
export function registerFormatProfile(profile: FormatProfile): () => void {
  PROFILES.unshift(profile);
  return () => {
    const idx = PROFILES.indexOf(profile);
    if (idx >= 0) PROFILES.splice(idx, 1);
  };
}

/**
 * Résout la stratégie applicable à un chemin JSON Pointer dans un profil.
 *
 * Recherche : exact match d'abord, puis fallback à la stratégie par défaut
 * du profil. Les wildcards "*" dans les paths du profil matchent un segment
 * unique du pointer.
 */
export function strategyForPath(
  profile: FormatProfile,
  pointer: string,
): PathStrategy {
  // Match exact
  if (profile.paths[pointer]) return profile.paths[pointer];
  // Match avec wildcards : on convertit chaque path-clé du profil en regex
  // (segments-by-segments, "*" → tout sauf "/").
  for (const [pathKey, strategy] of Object.entries(profile.paths)) {
    if (!pathKey.includes("*")) continue;
    if (matchesWildcardPath(pathKey, pointer)) return strategy;
  }
  return profile.default;
}

/** Match un JSON pointer contre un pattern à wildcards "*" (segment unique). */
function matchesWildcardPath(pattern: string, pointer: string): boolean {
  const patternSegs = pattern.split("/");
  const pointerSegs = pointer.split("/");
  if (patternSegs.length !== pointerSegs.length) return false;
  for (let i = 0; i < patternSegs.length; i++) {
    if (patternSegs[i] === "*") continue;
    if (patternSegs[i] !== pointerSegs[i]) return false;
  }
  return true;
}

export type { FormatProfile, PathStrategy, JsonPatchOp } from "./types.js";
