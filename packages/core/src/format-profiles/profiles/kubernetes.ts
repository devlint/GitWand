/**
 * GitWand — Profil "Kubernetes manifests"
 *
 * Match : fichiers .yaml / .yml dans un dossier k8s/, kubernetes/, manifests/
 * ou un déploiement courant (deployment.yaml, service.yaml, etc.). Heuristique
 * de path — pas de parsing du contenu pour confirmer le type de manifest
 * (Deployment vs Service vs ConfigMap), donc on applique des stratégies safe
 * sur les paths conventionnels qui n'existent que dans les types pertinents.
 *
 * Stratégies (alignées Kubernetes API conventions name-keyed lists) :
 * - /spec/template/spec/containers → set par "name"
 * - /spec/template/spec/initContainers → set par "name"
 * - /spec/template/spec/volumes → set par "name"
 * - /spec/template/spec/imagePullSecrets → set par "name"
 * - /spec/ports → set par "port" (Service)
 * - /spec/rules → set par "host" (Ingress) — fallback JSON.stringify si pas
 *   de host (Ingress sans rule "default")
 * - défaut → merge-keys
 */

import type { FormatProfile } from "../types.js";

const NAME_KEYED = (item: unknown): string => {
  if (typeof item === "object" && item !== null && "name" in item) {
    return String((item as { name: unknown }).name);
  }
  return JSON.stringify(item);
};

const PORT_KEYED = (item: unknown): string => {
  if (typeof item === "object" && item !== null && "port" in item) {
    return String((item as { port: unknown }).port);
  }
  return JSON.stringify(item);
};

const HOST_KEYED = (item: unknown): string => {
  if (typeof item === "object" && item !== null && "host" in item) {
    return String((item as { host: unknown }).host);
  }
  return JSON.stringify(item);
};

const K8S_DIR = /(^|\/)(k8s|kubernetes|manifests)\//;
const K8S_BASENAME = /^(deployment|service|ingress|configmap|secret|statefulset|daemonset|job|cronjob|replicaset|pod|namespace)\.(ya?ml)$/i;

export const kubernetesProfile: FormatProfile = {
  name: "kubernetes",
  matches: (filePath) => {
    if (!/\.ya?ml$/.test(filePath)) return false;
    if (K8S_DIR.test(filePath)) return true;
    const basename = filePath.split("/").pop() ?? "";
    return K8S_BASENAME.test(basename);
  },
  paths: {
    "/spec/template/spec/containers": { kind: "set", identity: NAME_KEYED },
    "/spec/template/spec/initContainers": { kind: "set", identity: NAME_KEYED },
    "/spec/template/spec/volumes": { kind: "set", identity: NAME_KEYED },
    "/spec/template/spec/imagePullSecrets": { kind: "set", identity: NAME_KEYED },
    "/spec/ports": { kind: "set", identity: PORT_KEYED },
    "/spec/rules": { kind: "set", identity: HOST_KEYED },
  },
  default: { kind: "merge-keys" },
};
