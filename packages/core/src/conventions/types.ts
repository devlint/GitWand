/**
 * GitWand — Conventions de dépôt (accuracy lot F)
 *
 * Une convention n'est pas une préférence déclarée : c'est une politique
 * MESURÉE sur l'historique de merges du dépôt lui-même. La dérivation rejoue
 * les merges passés sous des règles candidates et score laquelle correspond à
 * ce que l'équipe a réellement commité.
 *
 * Deux garde-fous structurels :
 *  - un verdict n'existe qu'au-dessus d'un plancher de preuve (échantillons et
 *    taux d'accord) — en dessous, le champ est absent et le moteur garde ses
 *    défauts calibrés sur le corpus public ;
 *  - un `.gitwandrc` explicite gagne TOUJOURS sur une convention dérivée : une
 *    équipe qui déclare sa politique n'est jamais contredite par une inférence.
 */

/** Verdict d'une question, avec sa preuve. */
export interface ConventionVerdict<V extends string> {
  verdict: V;
  /** Nombre d'observations qui ont porté sur cette question. */
  samples: number;
  /** Part des observations en accord avec le verdict (0–1). */
  agreement: number;
}

export interface RepoConventions {
  /** Traçabilité de la dérivation — les consommateurs DOIVENT l'afficher. */
  evidence: {
    mergesReplayed: number;
    conflictedFiles: number;
    derivedAt: string;
    engineVersion: string;
  };
  /**
   * Les fichiers générés de ce dépôt sont-ils re-générés après merge
   * (`regenerate` — la sortie d'un outil, jamais fusionnée) ou réellement
   * fusionnés (`merge` — l'auto-résolution correspond à ce qui est livré) ?
   */
  generatedFiles?: ConventionVerdict<"regenerate" | "merge">;
  /**
   * Le changelog de ce dépôt : l'union des sections correspond-elle à ce qui
   * est livré (`union`), la structure de la branche cible gagne-t-elle
   * (`target-structure`), ou est-il reconstruit par l'outillage de release
   * (`tool-rebuilt` — aucune fusion textuelle ne le reproduit) ?
   */
  changelog?: ConventionVerdict<"union" | "target-structure" | "tool-rebuilt">;
  /**
   * Identité de version (champ `version`, `const VERSION`…) : la branche cible
   * la garde-t-elle (`target-wins`) ? Non dérivée en v1 — champ réservé, le
   * moteur applique la règle du lot C (cible) mesurée sur le corpus public.
   */
  versionIdentity?: ConventionVerdict<"target-wins" | "newest-wins">;
  /**
   * Politiques par famille de chemins découvertes dans l'historique (top-N,
   * plancher de preuve). v1 : dérivées et RAPPORTÉES (suggestion de
   * `patternOverrides` pour `.gitwandrc`), jamais appliquées silencieusement.
   */
  pathPolicies?: Array<{
    glob: string;
    policy: "prefer-ours" | "prefer-theirs";
    samples: number;
    agreement: number;
  }>;
}

/**
 * Une observation = un fichier en conflit d'un merge historique, rejoué.
 * `candidates` associe chaque règle candidate à « sa sortie correspond-elle
 * octet à octet à ce que l'équipe a commité ? ».
 */
export interface ConventionObservation {
  question: "generatedFiles" | "changelog" | "pathPolicy";
  path: string;
  /** Pour pathPolicy : la famille de chemins (ex: "**\/*.md"). */
  bucket?: string;
  candidates: Record<string, boolean>;
}

/** Planchers de preuve — en dessous, pas de verdict. */
export const MIN_SAMPLES = 5;
export const MIN_AGREEMENT = 0.8;
/** Symétrique : un candidat est réfuté quand son accord tombe sous ce seuil. */
export const MAX_REFUTED = 0.2;
