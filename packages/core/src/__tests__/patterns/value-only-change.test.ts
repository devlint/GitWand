/**
 * Tests du pattern value_only_change (priority 60)
 *
 * Nécessite diff2 (sans base).
 * Détection : même nombre de lignes ET detectValueOnlyChange() réussit —
 * les lignes diffèrent uniquement sur des valeurs scalaires volatiles
 * (version, hash, checksum, timestamp, UUID, integrity hash, etc.).
 * Auto-résolu (prend theirs ou ours selon la politique).
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── Cas qui doivent matcher value_only_change ───────────────

describe("value_only_change : numéros de version (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `  "version": "1.0.0"`,
    `=======`,
    `  "version": "2.0.0"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en value_only_change", () => {
    const result = resolve(input, "package.json");
    expect(result.hunks[0].type).toBe("value_only_change");
  });

  it("auto-résout (autoResolved === 1)", () => {
    const result = resolve(input, "package.json");
    expect(result.stats.autoResolved).toBe(1);
  });
});

describe("value_only_change : checksums différents (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `checksum = "abc123def456"`,
    `=======`,
    `checksum = "def456abc123"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en value_only_change", () => {
    const result = resolve(input, "Cargo.lock");
    expect(result.hunks[0].type).toBe("value_only_change");
  });

  it("auto-résout", () => {
    const result = resolve(input, "Cargo.lock");
    expect(result.stats.autoResolved).toBe(1);
  });
});

describe("value_only_change : integrity hash npm (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `      "integrity": "sha512-aaaaaaaaaaaaaaaa=="`,
    `=======`,
    `      "integrity": "sha512-bbbbbbbbbbbbbbbb=="`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en value_only_change", () => {
    const result = resolve(input, "package-lock.json");
    expect(result.hunks[0].type).toBe("value_only_change");
  });

  it("auto-résout", () => {
    const result = resolve(input, "package-lock.json");
    expect(result.stats.autoResolved).toBe(1);
  });
});

describe("value_only_change : multiple lignes avec valeurs scalaires (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `  "version": "1.2.3",`,
    `  "resolved": "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz"`,
    `=======`,
    `  "version": "1.2.4",`,
    `  "resolved": "https://registry.npmjs.org/pkg/-/pkg-1.2.4.tgz"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en value_only_change", () => {
    const result = resolve(input, "package-lock.json");
    expect(result.hunks[0].type).toBe("value_only_change");
  });

  it("auto-résout", () => {
    const result = resolve(input, "package-lock.json");
    expect(result.stats.autoResolved).toBe(1);
  });
});

describe("value_only_change : hash de commit (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `  source = "git+https://github.com/org/repo?rev=aabbccdd11223344"`,
    `=======`,
    `  source = "git+https://github.com/org/repo?rev=99887766aabbccdd"`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en value_only_change", () => {
    const result = resolve(input, "Cargo.lock");
    expect(result.hunks[0].type).toBe("value_only_change");
  });

  it("auto-résout", () => {
    const result = resolve(input, "Cargo.lock");
    expect(result.stats.autoResolved).toBe(1);
  });
});

// ─── Cas qui ne doivent PAS matcher value_only_change ────────

describe("value_only_change : cas qui ne doivent pas matcher", () => {
  it("ne matche pas si les noms de clés changent (pas seulement des valeurs)", () => {
    const input = [
      `<<<<<<< ours`,
      `  "oldKey": "value",`,
      `=======`,
      `  "newKey": "value",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "package.json");
    expect(result.hunks[0].type).not.toBe("value_only_change");
  });

  it("ne matche pas si le nombre de lignes diffère", () => {
    const input = [
      `<<<<<<< ours`,
      `  "version": "1.0.0",`,
      `  "extra": "line",`,
      `=======`,
      `  "version": "2.0.0",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "package.json");
    expect(result.hunks[0].type).not.toBe("value_only_change");
  });

  it("ne matche pas si la structure du code change (pas juste des valeurs)", () => {
    const input = [
      `<<<<<<< ours`,
      `const x = computeValue();`,
      `=======`,
      `const x = 42;`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/test.ts");
    expect(result.hunks[0].type).not.toBe("value_only_change");
  });

  it("ne matche pas si les deux côtés sont identiques (same_change prioritaire)", () => {
    const input = [
      `<<<<<<< ours`,
      `  "version": "1.0.0"`,
      `=======`,
      `  "version": "1.0.0"`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "package.json");
    expect(result.hunks[0].type).toBe("same_change");
  });

  it("ne matche pas si les noms de fonctions changent", () => {
    const input = [
      `<<<<<<< ours`,
      `function handleLogin() {`,
      `=======`,
      `function handleSignIn() {`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/auth.ts");
    expect(result.hunks[0].type).not.toBe("value_only_change");
  });
});

// ─── Extension diff3 + résolution semver-max ─────────────────────────────────

describe("value_only_change : extension diff3 (les deux côtés ont changé la valeur)", () => {
  // Avant : requires "diff2" → le pattern était inatteignable dès que la base
  // était présente (donc quasi mort dans le flux desktop où la base recovery
  // enrichit tout en diff3) et le hunk tombait en complex.
  it("classifie value_only_change en diff3 quand les deux côtés ont bumpé une version différemment", () => {
    const input = [
      `<<<<<<< ours`,
      `"version": "1.4.0",`,
      `||||||| base`,
      `"version": "1.2.0",`,
      `=======`,
      `"version": "1.3.0",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "manifest.txt");
    expect(result.hunks[0].type).toBe("value_only_change");
  });

  it("en diff3, un changement unilatéral reste pris par one_side_change (prio 30 < 60)", () => {
    const input = [
      `<<<<<<< ours`,
      `"version": "1.2.0",`,
      `||||||| base`,
      `"version": "1.2.0",`,
      `=======`,
      `"version": "1.3.0",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "manifest.txt");
    expect(result.hunks[0].type).toBe("one_side_change");
  });
});

describe("value_only_change : résolution semver-max au lieu du côté-politique aveugle", () => {
  // Régression : l'explication promettait « accepter la version la plus
  // récente » mais la résolution prenait theirs par politique — probe P4 :
  // ours=1.4.0, theirs=1.3.0 → 1.3.0 gagnait. Quand toutes les paires de
  // tokens différents sont des semver comparables, le côté le plus élevé
  // doit gagner, quel que soit le côté.
  it("ours=1.4.0 vs theirs=1.3.0 → prend ours (le plus élevé)", () => {
    const input = [
      `<<<<<<< ours`,
      `"version": "1.4.0",`,
      `=======`,
      `"version": "1.3.0",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "manifest.txt");
    expect(result.hunks[0].type).toBe("value_only_change");
    expect(result.resolutions[0].resolvedLines).toEqual([`"version": "1.4.0",`]);
  });

  it("ours=1.3.0 vs theirs=2.0.0 → prend theirs (le plus élevé)", () => {
    const input = [
      `<<<<<<< ours`,
      `"version": "1.3.0",`,
      `=======`,
      `"version": "2.0.0",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "manifest.txt");
    expect(result.resolutions[0].resolvedLines).toEqual([`"version": "2.0.0",`]);
  });

  it("valeurs non-semver (hashes) → côté politique comme avant", () => {
    const input = [
      `<<<<<<< ours`,
      `integrity: "a1b2c3d4e5f6789",`,
      `=======`,
      `integrity: "f6e5d4c3b2a1987",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "manifest.txt");
    expect(result.hunks[0].type).toBe("value_only_change");
    // Politique par défaut : theirs
    expect(result.resolutions[0].resolvedLines).toEqual([`integrity: "f6e5d4c3b2a1987",`]);
  });

  it("l'explication ne prétend plus que theirs est « la plus récente »", () => {
    const input = [
      `<<<<<<< ours`,
      `"version": "1.4.0",`,
      `=======`,
      `"version": "1.3.0",`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "manifest.txt");
    expect(result.hunks[0].explanation).not.toContain("la plus récente (theirs)");
  });
});
