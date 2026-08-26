/**
 * GitWand — Dérivation des conventions (accuracy lot F).
 *
 * Fonction PURE : des observations en entrée (chaque fichier en conflit d'un
 * merge historique, rejoué sous des règles candidates), des verdicts en sortie.
 * Ni git, ni fs, ni horloge — le runner côté appelant fournit tout, y compris
 * `derivedAt` et `engineVersion`, pour rester rejouable et testable.
 */

import {
  MAX_REFUTED,
  MIN_AGREEMENT,
  MIN_SAMPLES,
  type ConventionObservation,
  type ConventionVerdict,
  type RepoConventions,
} from "./types.js";

interface Tally {
  samples: number;
  matches: Record<string, number>;
}

function tally(observations: ConventionObservation[], question: ConventionObservation["question"]): Tally {
  const t: Tally = { samples: 0, matches: {} };
  for (const obs of observations) {
    if (obs.question !== question) continue;
    t.samples++;
    for (const [candidate, matched] of Object.entries(obs.candidates)) {
      t.matches[candidate] = (t.matches[candidate] ?? 0) + (matched ? 1 : 0);
    }
  }
  return t;
}

const rate = (t: Tally, candidate: string): number =>
  t.samples === 0 ? 0 : (t.matches[candidate] ?? 0) / t.samples;

/**
 * Dérive les verdicts. Chaque question a sa propre logique, mais toutes
 * partagent les planchers : `samples >= MIN_SAMPLES`, et un verdict n'est
 * émis que s'il est net (confirmé ≥ MIN_AGREEMENT, ou réfuté ≤ MAX_REFUTED
 * quand le verdict est « l'inverse du candidat mesurable »).
 */
export function deriveConventions(
  observations: ConventionObservation[],
  meta: { mergesReplayed: number; derivedAt: string; engineVersion: string },
): RepoConventions {
  const conventions: RepoConventions = {
    evidence: {
      mergesReplayed: meta.mergesReplayed,
      conflictedFiles: observations.length,
      derivedAt: meta.derivedAt,
      engineVersion: meta.engineVersion,
    },
  };

  // ── generatedFiles ─────────────────────────────────────────────────────────
  // Un seul candidat mesurable : « merge » (la fusion sémantique correspond au
  // commit). « regenerate » est son inverse — on ne peut pas produire la sortie
  // d'un outil, mais on peut constater que la fusion ne la reproduit jamais.
  {
    const t = tally(observations, "generatedFiles");
    if (t.samples >= MIN_SAMPLES) {
      const merge = rate(t, "merge");
      if (merge >= MIN_AGREEMENT) {
        conventions.generatedFiles = { verdict: "merge", samples: t.samples, agreement: merge };
      } else if (merge <= MAX_REFUTED) {
        conventions.generatedFiles = { verdict: "regenerate", samples: t.samples, agreement: 1 - merge };
      }
      // Entre les deux : preuve contradictoire → pas de verdict.
    }
  }

  // ── changelog ──────────────────────────────────────────────────────────────
  // Deux candidats mesurables : « union » (la fusion des sections correspond)
  // et « target-structure » (le fichier livré est le côté cible tel quel).
  // « tool-rebuilt » est le constat que NI l'un NI l'autre ne correspond.
  {
    const t = tally(observations, "changelog");
    if (t.samples >= MIN_SAMPLES) {
      const union = rate(t, "union");
      const target = rate(t, "target-structure");
      let verdict: ConventionVerdict<"union" | "target-structure" | "tool-rebuilt"> | undefined;
      if (union >= MIN_AGREEMENT) {
        verdict = { verdict: "union", samples: t.samples, agreement: union };
      } else if (target >= MIN_AGREEMENT) {
        verdict = { verdict: "target-structure", samples: t.samples, agreement: target };
      } else if (union <= MAX_REFUTED && target <= MAX_REFUTED) {
        verdict = { verdict: "tool-rebuilt", samples: t.samples, agreement: 1 - Math.max(union, target) };
      }
      if (verdict) conventions.changelog = verdict;
    }
  }

  // ── pathPolicies ───────────────────────────────────────────────────────────
  // Par famille de chemins (bucket), deux candidats : le fichier livré est le
  // côté ours tel quel, ou le côté theirs tel quel. Dérivées et rapportées —
  // jamais appliquées silencieusement (v1) : le CLI en fait une suggestion de
  // `patternOverrides` que l'utilisateur promeut en `.gitwandrc` s'il veut.
  {
    const byBucket = new Map<string, Tally>();
    for (const obs of observations) {
      if (obs.question !== "pathPolicy" || !obs.bucket) continue;
      const t = byBucket.get(obs.bucket) ?? { samples: 0, matches: {} };
      t.samples++;
      for (const [candidate, matched] of Object.entries(obs.candidates)) {
        t.matches[candidate] = (t.matches[candidate] ?? 0) + (matched ? 1 : 0);
      }
      byBucket.set(obs.bucket, t);
    }
    const policies: NonNullable<RepoConventions["pathPolicies"]> = [];
    for (const [bucket, t] of byBucket) {
      if (t.samples < MIN_SAMPLES) continue;
      const ours = rate(t, "prefer-ours");
      const theirs = rate(t, "prefer-theirs");
      // Un seul des deux peut être net — s'ils le sont tous les deux, les
      // fichiers étaient identiques des deux côtés et la preuve ne vaut rien.
      if (ours >= MIN_AGREEMENT && theirs < MIN_AGREEMENT) {
        policies.push({ glob: bucket, policy: "prefer-ours", samples: t.samples, agreement: ours });
      } else if (theirs >= MIN_AGREEMENT && ours < MIN_AGREEMENT) {
        policies.push({ glob: bucket, policy: "prefer-theirs", samples: t.samples, agreement: theirs });
      }
    }
    policies.sort((a, b) => b.samples - a.samples || b.agreement - a.agreement);
    if (policies.length > 0) conventions.pathPolicies = policies.slice(0, 8);
  }

  return conventions;
}
