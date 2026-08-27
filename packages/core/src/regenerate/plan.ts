/**
 * accuracy lot D — Émission d'un plan de régénération (fonction pure, zéro I/O).
 *
 * Le moteur n'exécute jamais rien : `buildRegenerationPlan` se contente de
 * lire l'état (déjà connu de l'appelant, voir `RegenerationContext` dans
 * `types.ts`) des fichiers "sources de vérité" d'un écosystème régénérable,
 * et de décider si régénérer serait sûr (`runnable`). L'exécution de la
 * commande elle-même appartient toujours à l'appelant.
 */

import type { RegenerationContext } from "../types.js";
import type { RegenEcosystem } from "./registry.js";

/** Ce que le moteur émet à la place d'une résolution ; l'appelant décide de l'exécuter. */
export interface RegenerationPlan {
  file: string;
  ecosystem: RegenEcosystem["id"];
  /** Chaque source de vérité et comment elle a été réglée (clean | resolved | conflicted). */
  sources: Array<{ path: string; state: "clean" | "resolved" | "conflicted"; confidence?: number }>;
  /** Le plan n'est runnable que si aucune source n'est "conflicted" (absente = conflicted). */
  runnable: boolean;
}

/**
 * Construit le plan de régénération pour `file` dans l'écosystème `ecosystem`,
 * à partir de l'état des fichiers voisins fourni par l'appelant (`context`).
 *
 * Une source de vérité absente de `context.siblingFiles` est traitée comme
 * "conflicted" (état inconnu = pas sûr de régénérer) — jamais runnable par défaut.
 */
export function buildRegenerationPlan(
  file: string,
  ecosystem: RegenEcosystem,
  context: RegenerationContext | null | undefined,
): RegenerationPlan {
  const siblingFiles = context?.siblingFiles ?? {};

  const sources = ecosystem.sourcesOfTruth.map((path) => {
    const sibling = siblingFiles[path];
    if (!sibling) {
      return { path, state: "conflicted" as const };
    }
    return { path, state: sibling.state, confidence: sibling.confidence };
  });

  const runnable = sources.every((source) => source.state === "clean" || source.state === "resolved");

  return { file, ecosystem: ecosystem.id, sources, runnable };
}
