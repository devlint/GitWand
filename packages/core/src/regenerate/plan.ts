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
  /**
   * Final-review Finding 1 — renseigné uniquement quand `runnable` est forcé à
   * `false` pour une raison AUTRE que l'état d'une source (aujourd'hui :
   * fichier généré niché dans un sous-répertoire). Absent dans tous les
   * autres cas — ne pas s'y fier pour distinguer "runnable" de "non-runnable",
   * seul `runnable` fait foi ; ce champ n'existe que pour donner une raison
   * lisible quand il y en a une plus précise que "une source est conflictuelle".
   */
  blockedReason?: string;
}

/**
 * Construit le plan de régénération pour `file` dans l'écosystème `ecosystem`,
 * à partir de l'état des fichiers voisins fourni par l'appelant (`context`).
 *
 * Une source de vérité absente de `context.siblingFiles` est traitée comme
 * "conflicted" (état inconnu = pas sûr de régénérer) — jamais runnable par défaut.
 *
 * Final-review Finding 1 — fichiers générés NICHÉS (non à la racine du dépôt).
 * `findEcosystem`/`GENERATED_FILE_PATTERNS` matchent volontairement les
 * lockfiles nichés (ex: `packages/x/package-lock.json` → npm, voir
 * `registry.ts` et son test) mais rien en aval n'est conscient du répertoire :
 * le runner CLI écrit chaque source de vérité résolue à la RACINE du worktree
 * jetable, y lance l'installeur avec `cwd` = cette racine, puis relit le
 * fichier régénéré à son chemin niché — jamais touché par un install lancé à
 * la racine. Résultat possible sans cette garde : un plan jugé runnable qui
 * régénère silencieusement le lockfile RACINE pendant que le lockfile niché
 * (resté tel quel, encore "ours") est relu, valide car simplement périmé, et
 * présenté comme un succès de régénération — exactement le mode d'échec
 * (sortie fausse mais présentée comme fiable) que ce lot existe pour éliminer.
 * Bloqué ici, une seule fois, pour TOUS les appelants (`resolver/index.ts`
 * pass 1, la pass 2 du CLI, le reporting MCP, le harness de mesure) plutôt que
 * dupliqué dans chacun — voir le brief de la fix wave finale.
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

  const normalizedFile = file.replace(/\\/g, "/");
  if (normalizedFile.includes("/")) {
    return {
      file,
      ecosystem: ecosystem.id,
      sources,
      runnable: false,
      blockedReason: `régénération non supportée pour un fichier généré niché dans un sous-répertoire ("${file}") — résous-le manuellement ou relance ton installeur depuis ce répertoire.`,
    };
  }

  const runnable = sources.every((source) => source.state === "clean" || source.state === "resolved");

  return { file, ecosystem: ecosystem.id, sources, runnable };
}
