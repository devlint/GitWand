/**
 * Garde de régression pour la métrique "recoverable-before-model" (v2.7).
 *
 * Design: docs/superpowers/specs/2026-07-07-recoverable-before-model-metric-design.md §4.C
 *
 * Intention du design doc : `countReachingModel(corpus, { pattern: on }) ≤
 * countReachingModel(corpus, { pattern: off })`, pour transformer la métrique
 * en garde-fou — un nouveau pattern déterministe qui ne réduit jamais le
 * bucket AI-reachable est redondant ou masqué par un pattern de priorité
 * plus basse.
 *
 * Contrainte réelle de `token_level_merge` : ce n'est PAS un opt-in (toujours
 * dans `PATTERNS`, priority 65 — cf. packages/core/CLAUDE.md, "dérogation
 * délibérée"). Il n'existe donc pas de flag `{ token_level_merge: off }` à
 * passer à `resolve()`. On ne peut pas littéralement A/B tester le pipeline.
 *
 * Surrogate utilisé ici, dérivé de l'ordre de priorité (classifier.ts,
 * `65 < 970 < 998 < 999`) : un hunk classifié `token_level_merge` a par
 * construction déjà échoué tous les patterns triviaux (priority 10–60) — s'il
 * n'existait pas, la classification continuerait vers `refactoring_aware_merge`
 * (970, désactivé ici) puis `llm_proposed`/`complex` (998/999). Donc, sans
 * `refactoringAware` activé, chaque hunk réellement capturé par
 * `token_level_merge` serait tombé dans le bucket model/unresolved en son
 * absence. `countReachingModel(off)` hypothétique = `countReachingModel(on)`
 * + (nombre de hunks classifiés `token_level_merge`).
 *
 * Ça rend le test non-tautologique : si `token_level_merge` cesse de capturer
 * quoi que ce soit dans le corpus (pattern cassé, masqué par un pattern
 * inséré à une priorité plus basse, detect() régressé), `tokenLevelMergeCount`
 * tombe à 0 et l'assertion stricte échoue.
 */

import { describe, it, expect } from "vitest";
import { resolveAsync, resolve } from "../resolver/index.js";
import { CORPUS } from "./corpus.js";
import type { LlmEndpoint } from "../types.js";

function makeSpyEndpoint(): LlmEndpoint {
  return {
    async call(_prompt: string): Promise<string> {
      return "CANNOT_RESOLVE";
    },
  };
}

describe("Garde de régression — token_level_merge doit shrink le bucket AI-reachable", () => {
  it("countReachingModel(on) < countReachingModel(off) sur le corpus de référence", async () => {
    const endpoint = makeSpyEndpoint();
    let modelOrUnresolvedCount = 0; // countReachingModel(on) — pipeline réel
    let tokenLevelMergeCount = 0;

    for (const fixture of CORPUS) {
      const result = await resolveAsync(fixture.input, fixture.filePath, {
        ...fixture.options,
        llmFallback: { enabled: true, endpoint },
        validationLevel: "off",
      });
      for (const hunk of result.hunks) {
        if (hunk.type === "token_level_merge") tokenLevelMergeCount++;
        if (hunk.type === "llm_proposed" || hunk.type === "complex") modelOrUnresolvedCount++;
      }
    }

    // Le corpus doit contenir au moins un cas dépendant de token_level_merge —
    // sinon ce garde ne garde rien (cf. F46, la fixture Tailwind du v2.7).
    expect(tokenLevelMergeCount).toBeGreaterThan(0);

    const countReachingModelOn = modelOrUnresolvedCount;
    const countReachingModelOffHypothetical = modelOrUnresolvedCount + tokenLevelMergeCount;

    expect(countReachingModelOn).toBeLessThanOrEqual(countReachingModelOffHypothetical);
    // Strict sur ce corpus précisément parce qu'il contient F46 — si ça devient
    // une égalité, token_level_merge ne capture plus rien : régression.
    expect(countReachingModelOn).toBeLessThan(countReachingModelOffHypothetical);
  });

  it("token_level_merge (priority 65) gagne sur refactoring_aware_merge (priority 970) pour un hunk partagé", () => {
    // §5 du plan — décision déjà tranchée par l'ordre de priorité existant
    // (classifier.ts) : même avec refactoringAware activé, un hunk que
    // token_level_merge sait résoudre est classifié token_level_merge, pas
    // refactoring_aware_merge, car il est évalué en premier et le classifier
    // s'arrête au premier match.
    const f46 = CORPUS.find((f) => f.id === "F46")!;
    const result = resolve(f46.input, f46.filePath, { refactoringAware: { enabled: true } });
    expect(result.hunks[0]!.type).toBe("token_level_merge");
  });
});
