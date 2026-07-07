/**
 * Coupling entre `llmFallback` et `refactoringAware` (v2.7).
 *
 * Bug : les deux opt-ins sont indépendants dans `DEFAULT_OPTIONS`. Si un
 * utilisateur active `llmFallback` sans `refactoringAware`, un hunk de
 * rename-des-deux-côtés — normalement récupérable de façon déterministe par
 * `refactoring_aware` (priority 970) — saute cette passe (désactivée) et
 * atterrit sur `llm_proposed` (998) : un guess IA là où une réponse
 * déterministe existait.
 *
 * Fix : `resolveAsync()` force `refactoringAware.enabled` quand `llmFallback`
 * est actif — le LLM ne doit être atteignable que pour les hunks qu'aucun
 * pattern déterministe activé ne peut résoudre.
 */

import { describe, it, expect } from "vitest";
import { resolveAsync, resolve } from "../resolver/index.js";
import type { LlmEndpoint } from "../types.js";

/** Endpoint mock — ne doit JAMAIS être appelé dans les cas testés ici. */
function makeSpyEndpoint(): { endpoint: LlmEndpoint; callCount: () => number } {
  let calls = 0;
  return {
    endpoint: {
      async call(_prompt: string): Promise<string> {
        calls++;
        return "CANNOT_RESOLVE";
      },
    },
    callCount: () => calls,
  };
}

/** Rename-des-deux-côtés : ours renomme x→value, theirs renomme x→item. */
const RENAME_BOTH_SIDES = [
  "<<<<<<< ours",
  "function compute(value) {",
  "  return value * 2;",
  "||||||| base",
  "function compute(x) {",
  "  return x * 2;",
  "=======",
  "function compute(item) {",
  "  return item * 2;",
  ">>>>>>> theirs",
  "}",
].join("\n");

/** Conflit réellement complexe (pas un rename) — doit continuer à atterrir sur llm_proposed. */
const GENUINE_COMPLEX = [
  `<<<<<<< ours`,
  `  level: "warn",`,
  `  format: "json",`,
  `||||||| base`,
  `  level: "info",`,
  `  format: "text",`,
  `=======`,
  `  level: "error",`,
  `  format: "logfmt",`,
  `>>>>>>> theirs`,
].join("\n");

describe("resolveAsync — couplage llmFallback / refactoringAware", () => {
  it("un rename-des-deux-côtés n'est PAS envoyé au LLM quand llmFallback est actif sans refactoringAware explicite", async () => {
    const { endpoint, callCount } = makeSpyEndpoint();

    const result = await resolveAsync(RENAME_BOTH_SIDES, "test.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
      // refactoringAware volontairement absent — c'est le bug à couvrir.
    });

    expect(result.hunks[0].type).not.toBe("llm_proposed");
    expect(result.hunks[0].type).toBe("refactoring_aware_merge");
    expect(callCount()).toBe(0);
  });

  it("respecte un refactoringAware.enabled=false explicite en le forçant quand même (le LLM reste un plancher, pas un pair)", async () => {
    const { endpoint, callCount } = makeSpyEndpoint();

    const result = await resolveAsync(RENAME_BOTH_SIDES, "test.ts", {
      llmFallback: { enabled: true, endpoint },
      refactoringAware: { enabled: false },
      validationLevel: "off",
    });

    expect(result.hunks[0].type).toBe("refactoring_aware_merge");
    expect(callCount()).toBe(0);
  });

  it("non-régression : un conflit réellement complexe (pas un rename) continue d'atterrir sur llm_proposed", async () => {
    const { endpoint, callCount } = makeSpyEndpoint();

    const result = await resolveAsync(GENUINE_COMPLEX, "src/config.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
    });

    expect(result.hunks[0].type).toBe("llm_proposed");
    expect(callCount()).toBe(1);
  });

  it("pas de fuite du flag _refMergeEnabled : un resolve() normal après un resolveAsync couplé ne classe pas en refactoring_aware", async () => {
    const { endpoint } = makeSpyEndpoint();

    await resolveAsync(RENAME_BOTH_SIDES, "test.ts", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
    });

    // Nouvel appel sync, sans refactoringAware — le flag module-level doit
    // être retombé à false après le premier appel.
    const plain = resolve(RENAME_BOTH_SIDES, "test.ts", {});
    expect(plain.hunks[0].type).not.toBe("refactoring_aware_merge");
  });
});
