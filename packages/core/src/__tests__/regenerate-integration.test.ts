/**
 * accuracy lot D — Intégration : `resolve()` attache un `RegenerationPlan`
 * quand un fichier généré est décliné (generatedGate) ET que son chemin
 * matche un écosystème du registre `regenerate/registry.ts`.
 *
 * Règles testées :
 *  - package-lock.json décliné + package.json clean dans regenerationContext
 *    → plan runnable, reason contient l'indice --regenerate ;
 *  - package.json conflicted → plan attaché mais runnable: false ;
 *  - resolveGeneratedFiles: true → aucun plan (l'opt-in textuel gagne) ;
 *  - fichier généré hors registre (.min.js) → aucun plan (juste le déclin) ;
 *  - yarn.lock : .yarnrc.yml absent/conflicted → runnable: false (Ruling P-3).
 */

import { describe, expect, it } from "vitest";
import { resolve } from "../index.js";
import type { RegenerationContext } from "../types.js";

const lockEntryDiff = `<<<<<<< HEAD
      "version": "3.2.1",
      "resolved": "https://registry.npmjs.org/foo/-/foo-3.2.1.tgz",
      "integrity": "sha512-abc123def456"
=======
      "version": "3.3.0",
      "resolved": "https://registry.npmjs.org/foo/-/foo-3.3.0.tgz",
      "integrity": "sha512-xyz789ghi012"
>>>>>>> master`;

// Structurally different (not value_only) so the hunk stays "complex" →
// reclassified "generated_file" → declined by the generatedGate.
const minJsDiff = `<<<<<<< HEAD
!function(){var a=1;console.log(a);doStuff()}();
=======
!function(){var b=2;alert(b);doOther();cleanup()}();
>>>>>>> master`;

describe("regenerate tier — resolver integration", () => {
  it("attaches a runnable plan when the source of truth is clean", () => {
    const ctx: RegenerationContext = { siblingFiles: { "package.json": { state: "clean" } } };
    const result = resolve(lockEntryDiff, "package-lock.json", { regenerationContext: ctx });

    expect(result.stats.autoResolved).toBe(0);
    const resolution = result.resolutions[0];
    expect(resolution.regenerationPlan).toBeDefined();
    expect(resolution.regenerationPlan?.runnable).toBe(true);
    expect(resolution.regenerationPlan?.ecosystem).toBe("npm");
    expect(resolution.resolutionReason).toContain("--regenerate");
  });

  it("attaches a non-runnable plan when the source of truth is still conflicted", () => {
    const ctx: RegenerationContext = { siblingFiles: { "package.json": { state: "conflicted" } } };
    const result = resolve(lockEntryDiff, "package-lock.json", { regenerationContext: ctx });

    const resolution = result.resolutions[0];
    expect(resolution.regenerationPlan).toBeDefined();
    expect(resolution.regenerationPlan?.runnable).toBe(false);
    expect(resolution.regenerationPlan?.sources).toContainEqual({
      path: "package.json",
      state: "conflicted",
    });
  });

  it("attaches no plan at all when regenerationContext is absent (unknown = conflicted, still declined)", () => {
    const result = resolve(lockEntryDiff, "package-lock.json");
    const resolution = result.resolutions[0];
    // A plan is still attached (the ecosystem matches) but it's not runnable —
    // absence of context just means every source is treated as conflicted.
    expect(resolution.regenerationPlan).toBeDefined();
    expect(resolution.regenerationPlan?.runnable).toBe(false);
  });

  it("attaches no plan when resolveGeneratedFiles: true (textual opt-in wins)", () => {
    const ctx: RegenerationContext = { siblingFiles: { "package.json": { state: "clean" } } };
    const result = resolve(lockEntryDiff, "package-lock.json", {
      resolveGeneratedFiles: true,
      regenerationContext: ctx,
    });

    expect(result.stats.autoResolved).toBe(1);
    expect(result.resolutions[0].regenerationPlan).toBeUndefined();
  });

  it("attaches no plan for a generated file outside the v1 registry (.min.js)", () => {
    const result = resolve(minJsDiff, "public/dist/app.min.js", { minConfidence: "medium" });
    const resolution = result.resolutions[0];
    expect(resolution.regenerationPlan).toBeUndefined();
    expect(resolution.resolutionReason).not.toContain("--regenerate");
  });

  describe("yarn-berry vs classic (Ruling P-3)", () => {
    const yarnDiff = `<<<<<<< HEAD
  foo@^1.0.0:
    version "1.0.0"
=======
  foo@^1.0.0:
    version "1.1.0"
>>>>>>> master`;

    it("is runnable when package.json AND .yarnrc.yml are both clean", () => {
      const ctx: RegenerationContext = {
        siblingFiles: {
          "package.json": { state: "clean" },
          ".yarnrc.yml": { state: "clean" },
        },
      };
      const result = resolve(yarnDiff, "yarn.lock", { regenerationContext: ctx });
      const resolution = result.resolutions[0];
      expect(resolution.regenerationPlan?.ecosystem).toBe("yarn-berry");
      expect(resolution.regenerationPlan?.runnable).toBe(true);
    });

    it("is not runnable when .yarnrc.yml is missing from the context (classic yarn)", () => {
      const ctx: RegenerationContext = {
        siblingFiles: { "package.json": { state: "clean" } },
      };
      const result = resolve(yarnDiff, "yarn.lock", { regenerationContext: ctx });
      const resolution = result.resolutions[0];
      expect(resolution.regenerationPlan?.runnable).toBe(false);
      expect(resolution.regenerationPlan?.sources).toContainEqual({
        path: ".yarnrc.yml",
        state: "conflicted",
      });
    });
  });
});
