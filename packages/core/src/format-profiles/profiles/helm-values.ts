/**
 * GitWand — Profil "helm/values.yaml"
 *
 * Match : fichiers values.yaml ou values.<env>.yaml dans un répertoire
 * "helm/" ou "charts/" (conventions Helm). Match large pour couvrir les
 * monorepos avec sub-charts.
 *
 * Stratégies (s'appuient sur les conventions Kubernetes embarquées dans
 * Helm) :
 * - /spec/template/spec/containers → set par "name" (chaque container a un
 *   "name" unique selon les Pod specs Kubernetes)
 * - /spec/template/spec/initContainers → set par "name"
 * - /spec/template/spec/volumes → set par "name"
 * - /spec/template/spec/containers/* /env → set par "name" (env vars)
 *   (note : à la profondeur du wildcard, on raisonne sur l'entité de la
 *   liste env, pas sur l'item individuel)
 * - défaut → merge-keys
 */

import type { FormatProfile } from "../types.js";

const NAME_KEYED = (item: unknown): string => {
  if (typeof item === "object" && item !== null && "name" in item) {
    return String((item as { name: unknown }).name);
  }
  return JSON.stringify(item);
};

export const helmValuesProfile: FormatProfile = {
  name: "helm/values.yaml",
  matches: (filePath) => {
    if (!/values(\.[^/]+)?\.ya?ml$/.test(filePath)) return false;
    return /(^|\/)(helm|charts?)\//.test(filePath);
  },
  paths: {
    "/spec/template/spec/containers": { kind: "set", identity: NAME_KEYED },
    "/spec/template/spec/initContainers": { kind: "set", identity: NAME_KEYED },
    "/spec/template/spec/volumes": { kind: "set", identity: NAME_KEYED },
    "/spec/template/spec/imagePullSecrets": { kind: "set", identity: NAME_KEYED },
  },
  default: { kind: "merge-keys" },
};
