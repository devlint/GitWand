/**
 * Golden funnel — le gate CI anti-rot de la métrique recoverable-before-model.
 *
 * Origine : un commentaire du thread Show HN — « feels like the kind of number
 * that quietly rots the second nobody's watching it ». Réponse : le funnel
 * complet (byType agrégé sur tout le corpus + résumé par tier + compteurs
 * d'auto-résolution) est snapshotté dans `golden-funnel.json`, committé, et
 * comparé ici à chaque run CI. Tout changement de moteur qui déplace le funnel
 * doit toucher le fichier golden DANS LA MÊME PR — le nombre ne peut plus
 * dériver en silence, il ne peut que changer explicitement, sous review.
 *
 * ## Ce que ce gate ajoute aux assertions existantes
 *
 * - `corpus.test.ts` vérifie le type de `hunks[0]` par fixture ; ici on agrège
 *   TOUS les hunks de TOUTES les fixtures, dans deux configurations (défaut et
 *   refactoringAware) — un pattern qui se met à en shadower un autre, ou qui
 *   cesse de matcher sur un cas secondaire, apparaît dans le diff du golden.
 * - Les nombres dérivés (residual, aiReachable, recoverableBeforeModel) sont
 *   snapshotté s en absolu — comptes, pas ratios : sur un corpus de cette
 *   taille un ratio fait des embardées à chaque fixture ajoutée.
 *
 * ## Anti-Goodhart — la paire obligatoire
 *
 * Un gate « aiReachable ne doit pas croître » pris SEUL inciterait à rendre
 * les patterns plus agressifs pour garder le chiffre vert — exactement la
 * maladie « des patterns qui concurrencent l'IA au lieu de la backstopper ».
 * C'est pourquoi le golden snapshotte AUSSI `autoResolved` (une agressivité
 * nouvelle se voit comme un saut d'auto-résolution dans le même diff), et ce
 * test n'a de sens qu'à côté des assertions zéro-faux-positif de
 * `corpus.test.ts` (« complex n'est jamais auto-résolu »). L'un sans l'autre
 * est pire que rien.
 *
 * ## Mise à jour
 *
 * Changement de funnel intentionnel (nouveau pattern, fixture ajoutée, fix de
 * classification) :
 *
 *   npx vitest run src/__tests__/golden-funnel.test.ts -u
 *
 * puis relire le diff de `golden-funnel.json` dans la PR comme n'importe quel
 * changement de comportement.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import { summarizeTiers } from "../stats/tiers.js";
import { CORPUS } from "./corpus.js";
import type { ConflictType } from "../types.js";

interface FunnelSnapshot {
  fixtures: number;
  totalHunks: number;
  autoResolved: number;
  byType: Record<string, number>;
  tiers: {
    trivial: number;
    advancedDeterministic: number;
    model: number;
    unresolved: number;
    residual: number;
    aiReachable: number;
  };
}

/** Agrège le funnel sur tout le corpus pour une configuration d'options donnée. */
function computeFunnel(extraOptions: Record<string, unknown>): FunnelSnapshot {
  const byType: Partial<Record<ConflictType, number>> = {};
  let totalHunks = 0;
  let autoResolved = 0;

  for (const fixture of CORPUS) {
    const result = resolve(fixture.input, fixture.filePath, {
      ...(fixture.options ?? {}),
      ...extraOptions,
    });
    totalHunks += result.stats.totalConflicts;
    autoResolved += result.stats.autoResolved;
    for (const [type, count] of Object.entries(result.stats.byType)) {
      if (count > 0) {
        const t = type as ConflictType;
        byType[t] = (byType[t] ?? 0) + count;
      }
    }
  }

  const tiers = summarizeTiers(byType as Record<ConflictType, number>);
  return {
    fixtures: CORPUS.length,
    totalHunks,
    autoResolved,
    // Tri des clés pour un diff stable et lisible
    byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
    tiers: {
      trivial: tiers.byTier.trivial,
      advancedDeterministic: tiers.byTier.advancedDeterministic,
      model: tiers.byTier.model,
      unresolved: tiers.byTier.unresolved,
      residual: tiers.residual,
      aiReachable: tiers.aiReachable,
    },
  };
}

describe("Golden funnel — le funnel de résolution ne change jamais en silence", () => {
  it("configuration par défaut", async () => {
    const funnel = computeFunnel({});
    await expect(JSON.stringify(funnel, null, 2) + "\n")
      .toMatchFileSnapshot("./golden-funnel.default.json");
  });

  it("configuration refactoringAware activé", async () => {
    const funnel = computeFunnel({ refactoringAware: { enabled: true } });
    await expect(JSON.stringify(funnel, null, 2) + "\n")
      .toMatchFileSnapshot("./golden-funnel.refactoring.json");
  });

  it("invariant : activer refactoringAware ne fait jamais CROÎTRE le bucket AI-reachable", () => {
    const off = computeFunnel({});
    const on = computeFunnel({ refactoringAware: { enabled: true } });
    expect(on.tiers.aiReachable).toBeLessThanOrEqual(off.tiers.aiReachable);
  });
});
