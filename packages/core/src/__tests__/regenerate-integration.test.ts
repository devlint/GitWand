/**
 * accuracy lot D — Intégration : `resolve()` attache un `RegenerationPlan`
 * quand un fichier généré est décliné ET que son chemin matche un écosystème
 * du registre `regenerate/registry.ts`. Trois sites de déclin peuvent
 * attacher le plan (voir `attachRegenerationPlan` dans `resolver/index.ts`) :
 *  1. le `generatedGate` (hunks non-`generated_file`, ex: `value_only_change`) ;
 *  2. le seuil `minConfidence` poussé au-dessus de "high" sur un hunk
 *     `generated_file` (cas rare) ;
 *  3. `assembleResolution`'s case "generated_file" — le cas MAJORITAIRE :
 *     un lockfile réellement en conflit (chevauchement sémantique, pas un
 *     pattern "safe") est reclassifié `generated_file` par
 *     `reclassifyIfGenerated` avant même que `resolveHunk` ne tourne, donc
 *     le `generatedGate` (qui exclut `hunk.type === "generated_file"`) ne le
 *     voit jamais ; le déclin arrive plus loin, dans `assembleResolution`.
 *     Spec finding #1 (0 % d'accord sur `generated_file`) porte sur ce cas.
 *
 * Règles testées :
 *  - package-lock.json décliné (value_only_change, site 1) + package.json
 *    clean dans regenerationContext → plan runnable, reason contient
 *    l'indice --regenerate ;
 *  - package.json conflicted → plan attaché mais runnable: false ;
 *  - resolveGeneratedFiles: true → aucun plan (l'opt-in textuel gagne) ;
 *  - fichier généré hors registre (.min.js) → aucun plan (juste le déclin) ;
 *  - yarn.lock : .yarnrc.yml absent/conflicted → runnable: false (Ruling P-3) ;
 *  - lockfile GENUINELY conflicting (site 3, assembleResolution) → plan
 *    attaché aussi, avec le même hint et la même sémantique runnable/not ;
 *    resolveGeneratedFiles: true continue de prendre "accepter theirs" sans
 *    jamais décliner sur ce chemin (donc jamais de plan).
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
// reclassified "generated_file". Not in the v1 registry (.min.js), so no
// plan is attached regardless of which of the three sites declines it.
const minJsDiff = `<<<<<<< HEAD
!function(){var a=1;console.log(a);doStuff()}();
=======
!function(){var b=2;alert(b);doOther();cleanup()}();
>>>>>>> master`;

// Genuinely overlapping package-lock.json entry: both sides diverge from
// each other in STRUCTURE (not just a scalar value), so the classifier calls
// it "complex" → reclassifyIfGenerated turns it into "generated_file" BEFORE
// resolveHunk runs. This is what a real lockfile conflict looks like — the
// majority case (spec finding #1), reached via assembleResolution's
// case "generated_file", not the generatedGate branch.
const overlappingLockJsonDiff = `<<<<<<< HEAD
    "node_modules/foo": {
      "version": "1.0.0",
      "requires": { "bar": "^2.0" }
    }
=======
    "node_modules/foo": {
      "version": "1.1.0",
      "requires": { "bar": "^2.0", "baz": "^1.0" }
    }
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

  // Site 3 — assembleResolution's case "generated_file". The majority case:
  // a genuinely overlapping lockfile diff (real semantic conflict, not a
  // "safe" pattern), reclassified `generated_file` before resolveHunk runs,
  // so the generatedGate branch (site 1) never sees it.
  describe("genuinely-complex lockfile conflict (assembleResolution decline path)", () => {
    it("classifies as generated_file (not caught by the generatedGate)", () => {
      const result = resolve(overlappingLockJsonDiff, "package-lock.json", { minConfidence: "medium" });
      expect(result.hunks[0].type).toBe("generated_file");
    });

    it("attaches a runnable plan when package.json is clean", () => {
      const ctx: RegenerationContext = { siblingFiles: { "package.json": { state: "clean" } } };
      const result = resolve(overlappingLockJsonDiff, "package-lock.json", {
        minConfidence: "medium",
        regenerationContext: ctx,
      });

      expect(result.stats.autoResolved).toBe(0);
      const resolution = result.resolutions[0];
      expect(resolution.regenerationPlan).toBeDefined();
      expect(resolution.regenerationPlan?.runnable).toBe(true);
      expect(resolution.regenerationPlan?.ecosystem).toBe("npm");
      expect(resolution.resolutionReason).toContain("--regenerate");
    });

    it("attaches a non-runnable plan when package.json is conflicted", () => {
      const ctx: RegenerationContext = { siblingFiles: { "package.json": { state: "conflicted" } } };
      const result = resolve(overlappingLockJsonDiff, "package-lock.json", {
        minConfidence: "medium",
        regenerationContext: ctx,
      });

      const resolution = result.resolutions[0];
      expect(resolution.regenerationPlan).toBeDefined();
      expect(resolution.regenerationPlan?.runnable).toBe(false);
      expect(resolution.regenerationPlan?.sources).toContainEqual({
        path: "package.json",
        state: "conflicted",
      });
    });

    it("still attaches a (non-runnable) plan when regenerationContext is entirely absent", () => {
      const result = resolve(overlappingLockJsonDiff, "package-lock.json", { minConfidence: "medium" });
      const resolution = result.resolutions[0];
      expect(resolution.regenerationPlan).toBeDefined();
      expect(resolution.regenerationPlan?.runnable).toBe(false);
    });

    it("attaches no plan when resolveGeneratedFiles: true (this path takes accept-theirs, never declines)", () => {
      const ctx: RegenerationContext = { siblingFiles: { "package.json": { state: "clean" } } };
      const result = resolve(overlappingLockJsonDiff, "package-lock.json", {
        minConfidence: "medium",
        resolveGeneratedFiles: true,
        regenerationContext: ctx,
      });

      expect(result.stats.autoResolved).toBe(1);
      expect(result.resolutions[0].regenerationPlan).toBeUndefined();
      expect(result.resolutions[0].resolutionReason).not.toContain("--regenerate");
    });
  });
});
