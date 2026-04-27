/**
 * GitWand — Profil "tsconfig.json" (et tsconfig.*.json)
 *
 * Match : tout fichier nommé tsconfig.json ou tsconfig.<variant>.json
 * (ex: tsconfig.build.json, tsconfig.app.json) à n'importe quelle profondeur
 * dans le repo.
 *
 * Stratégies :
 * - /compilerOptions → merge-keys (objet de flags : on merge clé-par-clé)
 * - /compilerOptions/lib → set (tableau de strings, ordre indifférent)
 * - /compilerOptions/types → set
 * - /compilerOptions/typeRoots → set
 * - /include → set (globs, ordre indifférent)
 * - /exclude → set
 * - /references → set par "path" (objets {path: "..."} avec identité = path)
 * - /files → set
 * - défaut → merge-keys
 */

import type { FormatProfile } from "../types.js";

const TSCONFIG_NAME = /^tsconfig(\..+)?\.json$/;

export const tsconfigProfile: FormatProfile = {
  name: "tsconfig.json",
  matches: (filePath) => {
    const basename = filePath.split("/").pop() ?? filePath;
    return TSCONFIG_NAME.test(basename);
  },
  paths: {
    "/compilerOptions": { kind: "merge-keys" },
    "/compilerOptions/lib": { kind: "set" },
    "/compilerOptions/types": { kind: "set" },
    "/compilerOptions/typeRoots": { kind: "set" },
    "/compilerOptions/paths": { kind: "merge-keys" },
    "/include": { kind: "set" },
    "/exclude": { kind: "set" },
    "/files": { kind: "set" },
    "/references": {
      kind: "set",
      identity: (item) => {
        if (typeof item === "object" && item !== null && "path" in item) {
          return String((item as { path: unknown }).path);
        }
        return JSON.stringify(item);
      },
    },
  },
  default: { kind: "merge-keys" },
};
