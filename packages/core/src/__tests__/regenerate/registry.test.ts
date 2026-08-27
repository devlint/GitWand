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

  it("every v1 registry entry bakes in script-suppression or is inherently script-free", () => {
    // Global constraint: no registry entry may omit script suppression — either
    // an explicit flag (--ignore-scripts / --no-scripts) or a command that never
    // executes lifecycle scripts by construction (documented per entry below).
    for (const eco of REGEN_ECOSYSTEMS) {
      const args = eco.command.args.join(" ");
      const scriptSuppressed =
        args.includes("--ignore-scripts") ||
        args.includes("--no-scripts") ||
        eco.id === "yarn-berry" || // update-lockfile mode never runs installs/lifecycle scripts
        eco.id === "cargo"; // generate-lockfile only resolves, never builds/runs build.rs
      expect(scriptSuppressed).toBe(true);
    }
  });

  it("v1 registry has exactly the 5 documented ecosystems", () => {
    expect(REGEN_ECOSYSTEMS.map((e) => e.id).sort()).toEqual(
      ["cargo", "composer", "npm", "pnpm", "yarn-berry"].sort(),
    );
  });
});
