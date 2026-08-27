/**
 * accuracy lot D — Registre des écosystèmes régénérables (v1).
 *
 * `findEcosystem` doit matcher chacun des 5 lockfiles v1 et ne rien
 * retourner pour un fichier généré hors registre (`.min.js`).
 */

import { describe, expect, it } from "vitest";
import { findEcosystem, REGEN_ECOSYSTEMS } from "../../regenerate/registry.js";

describe("findEcosystem", () => {
  it.each([
    ["package-lock.json", "npm"],
    ["nested/dir/package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn-berry"],
    ["composer.lock", "composer"],
    ["Cargo.lock", "cargo"],
  ] as const)("matches %s → ecosystem %s", (path, ecosystemId) => {
    const ecosystem = findEcosystem(path);
    expect(ecosystem).toBeDefined();
    expect(ecosystem?.id).toBe(ecosystemId);
  });

  it("returns undefined for a non-registry generated file (.min.js)", () => {
    expect(findEcosystem("public/dist/app.min.js")).toBeUndefined();
  });

  it("returns undefined for an ordinary source file", () => {
    expect(findEcosystem("src/index.ts")).toBeUndefined();
  });

  describe("every v1 registry entry bakes in script-suppression", () => {
    // Global constraint: no registry entry may omit script suppression. For
    // npm/pnpm/composer that's an explicit flag on `command.args`. For
    // yarn-berry and cargo, suppression is inherent to the command CHOICE
    // itself (no flag exists to bolt onto a riskier command) — so instead of
    // a boolean short-circuit, each ecosystem gets its own real assertion
    // that fails if a future edit swaps in a script-running command.
    it("npm carries --ignore-scripts", () => {
      const eco = REGEN_ECOSYSTEMS.find((e) => e.id === "npm")!;
      expect(eco.command.args).toContain("--ignore-scripts");
    });

    it("pnpm carries --ignore-scripts", () => {
      const eco = REGEN_ECOSYSTEMS.find((e) => e.id === "pnpm")!;
      expect(eco.command.args).toContain("--ignore-scripts");
    });

    it("composer carries --no-scripts", () => {
      const eco = REGEN_ECOSYSTEMS.find((e) => e.id === "composer")!;
      expect(eco.command.args).toContain("--no-scripts");
    });

    it("yarn-berry carries --mode=update-lockfile (lockfile-only mode never runs install/lifecycle scripts)", () => {
      const eco = REGEN_ECOSYSTEMS.find((e) => e.id === "yarn-berry")!;
      expect(eco.command.args).toContain("--mode=update-lockfile");
    });

    it("cargo is exactly generate-lockfile (resolves only, never invokes build.rs)", () => {
      const eco = REGEN_ECOSYSTEMS.find((e) => e.id === "cargo")!;
      expect(eco.command.args).toEqual(["generate-lockfile"]);
    });
  });

  it("v1 registry has exactly the 5 documented ecosystems", () => {
    expect(REGEN_ECOSYSTEMS.map((e) => e.id).sort()).toEqual(
      ["cargo", "composer", "npm", "pnpm", "yarn-berry"].sort(),
    );
  });
});
