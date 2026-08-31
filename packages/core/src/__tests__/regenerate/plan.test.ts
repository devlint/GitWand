/**
 * accuracy lot D — `buildRegenerationPlan` : fonction pure, aucun I/O.
 *
 * Règles testées :
 *  - runnable uniquement quand toutes les sources sont clean/resolved ;
 *  - une source conflictuelle → runnable: false, nommée dans `sources` ;
 *  - une source absente du contexte → traitée comme conflictuelle (jamais
 *    "runnable par défaut") ;
 *  - contexte absent (`null`/`undefined`) → toutes les sources conflictuelles.
 */

import { describe, expect, it } from "vitest";
import { buildRegenerationPlan } from "../../regenerate/plan.js";
import { findEcosystem } from "../../regenerate/registry.js";
import type { RegenerationContext } from "../../types.js";

const npmEco = findEcosystem("package-lock.json")!;
const yarnBerryEco = findEcosystem("yarn.lock")!;

describe("buildRegenerationPlan", () => {
  it("is runnable when every source of truth is clean", () => {
    const ctx: RegenerationContext = {
      siblingFiles: { "package.json": { state: "clean" } },
    };
    const plan = buildRegenerationPlan("package-lock.json", npmEco, ctx);
    expect(plan.runnable).toBe(true);
    expect(plan.ecosystem).toBe("npm");
    expect(plan.file).toBe("package-lock.json");
    expect(plan.sources).toEqual([{ path: "package.json", state: "clean" }]);
  });

  it("is runnable when every source of truth is engine-resolved", () => {
    const ctx: RegenerationContext = {
      siblingFiles: { "package.json": { state: "resolved", confidence: 0.9 } },
    };
    const plan = buildRegenerationPlan("package-lock.json", npmEco, ctx);
    expect(plan.runnable).toBe(true);
    expect(plan.sources[0]).toEqual({ path: "package.json", state: "resolved", confidence: 0.9 });
  });

  it("is not runnable when a source of truth is still conflicted", () => {
    const ctx: RegenerationContext = {
      siblingFiles: { "package.json": { state: "conflicted" } },
    };
    const plan = buildRegenerationPlan("package-lock.json", npmEco, ctx);
    expect(plan.runnable).toBe(false);
    expect(plan.sources).toContainEqual({ path: "package.json", state: "conflicted" });
  });

  it("treats a source missing from siblingFiles as conflicted (not runnable by default)", () => {
    const ctx: RegenerationContext = { siblingFiles: {} };
    const plan = buildRegenerationPlan("package-lock.json", npmEco, ctx);
    expect(plan.runnable).toBe(false);
    expect(plan.sources).toEqual([{ path: "package.json", state: "conflicted" }]);
  });

  it("treats a null/undefined context as every source conflicted", () => {
    const planNull = buildRegenerationPlan("package-lock.json", npmEco, null);
    expect(planNull.runnable).toBe(false);
    expect(planNull.sources).toEqual([{ path: "package.json", state: "conflicted" }]);

    const planUndefined = buildRegenerationPlan("package-lock.json", npmEco, undefined);
    expect(planUndefined.runnable).toBe(false);
  });

  // Ruling P-3 — yarn-berry vs classic: `.yarnrc.yml` is the berry marker.
  describe("yarn-berry vs classic (Ruling P-3)", () => {
    it("is runnable when both package.json and .yarnrc.yml are clean/resolved", () => {
      const ctx: RegenerationContext = {
        siblingFiles: {
          "package.json": { state: "clean" },
          ".yarnrc.yml": { state: "clean" },
        },
      };
      const plan = buildRegenerationPlan("yarn.lock", yarnBerryEco, ctx);
      expect(plan.runnable).toBe(true);
      expect(plan.sources).toEqual(
        expect.arrayContaining([
          { path: "package.json", state: "clean" },
          { path: ".yarnrc.yml", state: "clean" },
        ]),
      );
    });

    it("is not runnable when .yarnrc.yml is absent (classic yarn, no berry marker)", () => {
      const ctx: RegenerationContext = {
        siblingFiles: { "package.json": { state: "clean" } },
      };
      const plan = buildRegenerationPlan("yarn.lock", yarnBerryEco, ctx);
      expect(plan.runnable).toBe(false);
      expect(plan.sources).toContainEqual({ path: ".yarnrc.yml", state: "conflicted" });
    });

    it("is not runnable when .yarnrc.yml is itself conflicted", () => {
      const ctx: RegenerationContext = {
        siblingFiles: {
          "package.json": { state: "clean" },
          ".yarnrc.yml": { state: "conflicted" },
        },
      };
      const plan = buildRegenerationPlan("yarn.lock", yarnBerryEco, ctx);
      expect(plan.runnable).toBe(false);
      expect(plan.sources).toContainEqual({ path: ".yarnrc.yml", state: "conflicted" });
    });
  });

  // Final review Finding 1 — a nested lockfile (e.g. `packages/x/package-lock.json`)
  // matches the registry (intentional — see registry.test.ts) but nothing
  // downstream is directory-aware: the CLI's regenerate-runner writes
  // resolved sources at the worktree ROOT and reads the regenerated lockfile
  // back from its nested path. Without this guard, a nested lockfile whose
  // (root-relative) sourcesOfTruth all read "clean" comes back runnable, and
  // executing that plan would silently regenerate the ROOT lockfile while
  // reading back an untouched (still-"ours") nested one — a false success.
  describe("nested (non-root) generated files (Finding 1, final review)", () => {
    it("is not runnable even when every source of truth is clean", () => {
      const ctx: RegenerationContext = {
        siblingFiles: { "package.json": { state: "clean" } },
      };
      const plan = buildRegenerationPlan("packages/x/package-lock.json", npmEco, ctx);
      expect(plan.runnable).toBe(false);
      expect(plan.blockedReason).toBeDefined();
      expect(plan.blockedReason).toContain("packages/x/package-lock.json");
    });

    it("carries no blockedReason for a root-level file (unaffected)", () => {
      const ctx: RegenerationContext = {
        siblingFiles: { "package.json": { state: "clean" } },
      };
      const plan = buildRegenerationPlan("package-lock.json", npmEco, ctx);
      expect(plan.runnable).toBe(true);
      expect(plan.blockedReason).toBeUndefined();
    });

    it("still reports the (root-relative) source states even though it's blocked", () => {
      const ctx: RegenerationContext = { siblingFiles: {} };
      const plan = buildRegenerationPlan("packages/x/package-lock.json", npmEco, ctx);
      expect(plan.runnable).toBe(false);
      expect(plan.sources).toEqual([{ path: "package.json", state: "conflicted" }]);
    });
  });
});
