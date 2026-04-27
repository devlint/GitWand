/**
 * GitWand — Profil "composer.json" (PHP)
 *
 * Match : tout fichier nommé composer.json (à n'importe quelle profondeur).
 * Analogue à package.json côté PHP.
 *
 * Stratégies :
 * - /require, /require-dev, /conflict, /provide, /replace, /suggest
 *   → merge-keys (objets clé-par-clé)
 * - /autoload, /autoload-dev → merge-keys (sous-objets PSR-4 / classmap…)
 * - /scripts → merge-keys
 * - /keywords → set
 * - /authors → set par "email" (objets {name, email}, identité = email)
 * - défaut → merge-keys
 */

import type { FormatProfile } from "../types.js";

export const composerProfile: FormatProfile = {
  name: "composer.json",
  matches: (filePath) => {
    const basename = filePath.split("/").pop() ?? filePath;
    return basename === "composer.json";
  },
  paths: {
    "/require": { kind: "merge-keys" },
    "/require-dev": { kind: "merge-keys" },
    "/conflict": { kind: "merge-keys" },
    "/provide": { kind: "merge-keys" },
    "/replace": { kind: "merge-keys" },
    "/suggest": { kind: "merge-keys" },
    "/autoload": { kind: "merge-keys" },
    "/autoload-dev": { kind: "merge-keys" },
    "/scripts": { kind: "merge-keys" },
    "/keywords": { kind: "set" },
    "/authors": {
      kind: "set",
      identity: (item) => {
        if (typeof item === "object" && item !== null && "email" in item) {
          return String((item as { email: unknown }).email);
        }
        return JSON.stringify(item);
      },
    },
  },
  default: { kind: "merge-keys" },
};
