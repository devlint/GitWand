/**
 * Tests du resolver JSON/JSONC (GitWand)
 *
 * Fixtures :
 *   F1 — clé ajoutée d'un seul côté
 *   F2 — même clé modifiée des deux côtés → conflit non résolvable
 *   F3 — JSON vide/minimal {}
 *   F4 — conflit dans package.json scripts
 *   F5 — conflit dans tsconfig.json compilerOptions
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F1 — clé ajoutée d'un seul côté ─────────────────────────────────────────

describe("F1 — JSON : clé ajoutée d'un seul côté (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0",`,
    `  "description": "A test app"`,
    `}`,
    `||||||| base`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0"`,
    `}`,
    `=======`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0"`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver json", () => {
    const result = resolve(input, "package.json");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient la clé ajoutée", () => {
    const result = resolve(input, "package.json");
    expect(result.mergedContent).toContain("description");
  });

  it("la raison mentionne [json]", () => {
    const result = resolve(input, "package.json");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[json\]/i);
  });
});

// ─── F2 — même clé modifiée des deux côtés ────────────────────────────────────
//
// v2.7 : value_only_change couvre désormais le diff3 (requires "both"). Ce
// fixture — version bumpée différemment des deux côtés — est exactement son
// cas nominal : résolution semver-max (3.0.0), déterministe. Avant, le hunk
// restait complex et le refus portait la note [json] ; ces assertions
// documentaient l'ancien trou de couverture, pas une intention.

describe("F2 — JSON : même clé (version) modifiée des deux côtés → semver-max", () => {
  const input = [
    `<<<<<<< ours`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "2.0.0"`,
    `}`,
    `||||||| base`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "1.0.0"`,
    `}`,
    `=======`,
    `{`,
    `  "name": "my-app",`,
    `  "version": "3.0.0"`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "package.json")).not.toThrow();
  });

  it("résout en gardant la version la plus élevée (theirs = 3.0.0)", () => {
    const result = resolve(input, "package.json");
    expect(result.hunks[0].type).toBe("value_only_change");
    expect(result.resolutions[0].autoResolved).toBe(true);
    expect(result.mergedContent).toContain('"version": "3.0.0"');
    expect(result.mergedContent).not.toContain('"version": "2.0.0"');
  });
});

// ─── F3 — JSON vide / minimal ─────────────────────────────────────────────────

describe("F3 — JSON minimal {} : ne plante pas", () => {
  const input = [
    `<<<<<<< ours`,
    `{}`,
    `||||||| base`,
    `{}`,
    `=======`,
    `{}`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "empty.json")).not.toThrow();
  });

  it("produit un résultat avec au moins un hunk", () => {
    const result = resolve(input, "empty.json");
    expect(result.hunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── F4 — conflit dans package.json scripts ───────────────────────────────────

describe("F4 — package.json : merge des scripts (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `{`,
    `  "scripts": {`,
    `    "build": "tsc",`,
    `    "test": "vitest",`,
    `    "lint": "eslint ."`,
    `  }`,
    `}`,
    `||||||| base`,
    `{`,
    `  "scripts": {`,
    `    "build": "tsc",`,
    `    "test": "vitest"`,
    `  }`,
    `}`,
    `=======`,
    `{`,
    `  "scripts": {`,
    `    "build": "tsc",`,
    `    "test": "vitest",`,
    `    "format": "prettier --write ."`,
    `  }`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver json", () => {
    const result = resolve(input, "package.json");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les scripts des deux côtés", () => {
    const result = resolve(input, "package.json");
    expect(result.mergedContent).toContain("lint");
    expect(result.mergedContent).toContain("format");
    expect(result.mergedContent).toContain("build");
    expect(result.mergedContent).toContain("test");
  });

  it("la raison mentionne [json]", () => {
    const result = resolve(input, "package.json");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[json\]/i);
  });
});

// ─── F5 — conflit dans tsconfig.json compilerOptions ─────────────────────────

describe("F5 — tsconfig.json : merge des compilerOptions (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `{`,
    `  "compilerOptions": {`,
    `    "target": "ES2022",`,
    `    "module": "ESNext",`,
    `    "strict": true,`,
    `    "noUncheckedIndexedAccess": true`,
    `  }`,
    `}`,
    `||||||| base`,
    `{`,
    `  "compilerOptions": {`,
    `    "target": "ES2022",`,
    `    "module": "ESNext",`,
    `    "strict": true`,
    `  }`,
    `}`,
    `=======`,
    `{`,
    `  "compilerOptions": {`,
    `    "target": "ES2022",`,
    `    "module": "ESNext",`,
    `    "strict": true,`,
    `    "exactOptionalPropertyTypes": true`,
    `  }`,
    `}`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver json", () => {
    const result = resolve(input, "tsconfig.json");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les options des deux côtés", () => {
    const result = resolve(input, "tsconfig.json");
    expect(result.mergedContent).toContain("noUncheckedIndexedAccess");
    expect(result.mergedContent).toContain("exactOptionalPropertyTypes");
    expect(result.mergedContent).toContain("strict");
  });

  it("la raison mentionne [json]", () => {
    const result = resolve(input, "tsconfig.json");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[json\]/i);
  });
});
