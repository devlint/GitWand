/**
 * GitWand — Profil "package.json"
 *
 * Match : tout fichier nommé exactement "package.json" (à la racine ou dans
 * un workspace). On exclut les fichiers générés type "package-lock.json"
 * (couverts par les résolveurs lockfile dédiés).
 *
 * Stratégies :
 * - /dependencies, /devDependencies, /peerDependencies, /optionalDependencies
 *   → merge-keys (objets clé-par-clé, comportement existant)
 * - /scripts → merge-keys (objets clé-par-clé)
 * - /keywords → set (tableau, identité = JSON.stringify de l'item)
 * - /workspaces (cas tableau) → set
 * - défaut → merge-keys
 */

import type { FormatProfile } from "../types.js";

export const packageJsonProfile: FormatProfile = {
  name: "package.json",
  matches: (filePath) => {
    const basename = filePath.split("/").pop() ?? filePath;
    return basename === "package.json";
  },
  paths: {
    "/dependencies": { kind: "merge-keys" },
    "/devDependencies": { kind: "merge-keys" },
    "/peerDependencies": { kind: "merge-keys" },
    "/optionalDependencies": { kind: "merge-keys" },
    "/bundledDependencies": { kind: "set" },
    "/bundleDependencies": { kind: "set" },
    "/scripts": { kind: "merge-keys" },
    "/keywords": { kind: "set" },
    "/files": { kind: "set" },
    "/workspaces": { kind: "set" },
  },
  default: { kind: "merge-keys" },
};
