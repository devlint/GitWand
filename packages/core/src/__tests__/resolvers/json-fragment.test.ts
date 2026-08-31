/**
 * accuracy lot E (lot E) — Fragments JSON fusionnés par clé.
 *
 * Les conflits réels de package.json / composer.json sont des fragments
 * « "clé": valeur, » — le doc complet ne parse pas, et l'union ligne à ligne
 * était mesurée juste 48–67 % du temps sur le corpus. Ici : 3-way par clé,
 * arbitrage borné des contraintes de version, déclin sur tout le reste.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "../../index.js";
import { tryResolveJsonFragment, pickNewerRange } from "../../resolvers/json-fragment.js";

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  ["<<<<<<< ours", ...ours, "||||||| base", ...base, "=======", ...theirs, ">>>>>>> theirs"].join("\n");

describe("pickNewerRange", () => {
  it("compares same-operator ranges and picks the newer", () => {
    expect(pickNewerRange('"^7.23.0"', '"^7.23.3"')).toBe('"^7.23.3"');
    expect(pickNewerRange('"~1.4.0"', '"~1.2.9"')).toBe('"~1.4.0"');
    expect(pickNewerRange('"2.0.0"', '"2.0.1"')).toBe('"2.0.1"');
  });
  it("declines mixed operators, wildcards and non-versions", () => {
    expect(pickNewerRange('"^1.2.0"', '"~1.4.0"')).toBeNull();
    expect(pickNewerRange('"1.x"', '"1.2.0"')).toBeNull();
    expect(pickNewerRange('"workspace:*"', '"^3.3.8"')).toBeNull();
  });
});

describe("json fragment merge (end-to-end through resolve)", () => {
  it("takes the one-sided dependency bump — the vue @babel/parser shape", () => {
    const content = [
      "{",
      '  "dependencies": {',
      conflict(
        ['    "@babel/parser": "^7.23.0",'],
        ['    "@babel/parser": "^7.23.0",'],
        ['    "@babel/parser": "^7.23.3",'],
      ),
      '    "source-map-js": "^1.0.2"',
      "  }",
      "}",
    ].join("\n");
    const result = resolve(content, "packages/compiler-core/package.json");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("^7.23.3");
    expect(result.mergedContent).not.toContain("^7.23.0");
  });

  it("keeps both sides' distinct additions, alphabetically when both sides are sorted", () => {
    const content = [
      "{",
      '  "require": {',
      conflict(
        ['    "aaa/pkg": "^1.0",', '    "mmm/pkg": "^2.0",'],
        [],
        ['    "aaa/pkg": "^1.0",', '    "zzz/pkg": "^3.0",'],
      ),
      '    "php": "^8.2"',
      "  }",
      "}",
    ].join("\n");
    const result = resolve(content, "composer.json");
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent!;
    const iA = merged.indexOf("aaa/pkg"), iM = merged.indexOf("mmm/pkg"), iZ = merged.indexOf("zzz/pkg");
    expect(iA).toBeGreaterThan(-1);
    expect(iM).toBeGreaterThan(iA);
    expect(iZ).toBeGreaterThan(iM);
  });

  it("arbitrates a both-sides bump with the same operator to the newer range", () => {
    const r = tryResolveJsonFragment(
      ['    "dep": "^1.0.0",'],
      ['    "dep": "^1.2.0",'],
      ['    "dep": "^1.4.1",'],
    );
    expect(r.lines).toEqual(['    "dep": "^1.4.1",']);
  });

  it("declines a real decision — same key, incomparable values (workspace:* migration)", () => {
    const content = [
      "{",
      '  "dependencies": {',
      conflict(
        ['    "@vue/shared": "3.4.0-alpha.1",'],
        ['    "@vue/shared": "3.3.7",'],
        ['    "@vue/shared": "workspace:*",'],
      ),
      '    "end": "1"',
      "  }",
      "}",
    ].join("\n");
    const result = resolve(content, "package.json");
    expect(result.stats.autoResolved).toBe(0);
  });

  it("never produces a duplicate key from a two-sided constraint conflict", () => {
    const content = [
      "{",
      conflict(
        ['  "illuminate/reflection": "^12.0",'],
        [],
        ['  "illuminate/reflection": "^13.0",'],
      ),
      '  "php": "^8.2"',
      "}",
    ].join("\n");
    const result = resolve(content, "composer.json");
    if (result.mergedContent !== null) {
      const occurrences = result.mergedContent.split("illuminate/reflection").length - 1;
      expect(occurrences).toBe(1);
      expect(result.mergedContent).toContain("^13.0"); // même opérateur → la plus récente
    }
  });

  it("declines fragments it does not fully understand (nested object lines)", () => {
    const r = tryResolveJsonFragment(
      [],
      ['  "scripts": {', '    "build": "tsc"', "  },"],
      ['  "scripts": {', '    "build": "vite build"', "  },"],
    );
    expect(r.lines).toBeNull();
  });

  it("handles deletion on one side, untouched on the other", () => {
    const r = tryResolveJsonFragment(
      ['  "old-dep": "^1.0.0",', '  "kept": "^2.0.0",'],
      ['  "kept": "^2.0.0",'],
      ['  "old-dep": "^1.0.0",', '  "kept": "^2.1.0",'],
    );
    expect(r.lines).toEqual(['  "kept": "^2.1.0",']);
  });
});
