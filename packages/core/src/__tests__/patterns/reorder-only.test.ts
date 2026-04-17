/**
 * Tests du pattern reorder_only (v1.4)
 *
 * Fixtures :
 *   F21 — imports triés alphabétiquement
 *   F22 — clés de config réorganisées
 * + cas limites : doublons, diff2 vs diff3, faux positifs
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F21 — exports triés alphabétiquement ────────────────────
// Note : on utilise des export statements (pas des imports) pour éviter
// que le resolver spécialisé d'imports ne prenne la main en premier.

describe("F21 — reorder_only : exports triés alphabétiquement (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `export { AuthService } from "./auth";`,
    `export { LogService } from "./log";`,
    `export { UserService } from "./user";`,
    `||||||| base`,
    `export { UserService } from "./user";`,
    `export { AuthService } from "./auth";`,
    `export { LogService } from "./log";`,
    `=======`,
    `export { LogService } from "./log";`,
    `export { AuthService } from "./auth";`,
    `export { UserService } from "./user";`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en reorder_only", () => {
    const result = resolve(input, "src/index.ts");
    expect(result.hunks[0].type).toBe("reorder_only");
  });

  it("auto-résout (confiance high ou certain)", () => {
    const result = resolve(input, "src/index.ts");
    expect(result.stats.autoResolved).toBe(1);
    expect(["high", "certain"]).toContain(result.hunks[0].confidence.label);
  });

  it("résolution = ordre theirs (base ≠ theirs)", () => {
    const result = resolve(input, "src/index.ts");
    // base = User, Auth, Log
    // theirs = Log, Auth, User → base ≠ theirs → accepter theirs
    const lines = result.mergedContent!.split("\n");
    expect(lines[0]).toContain('LogService');
  });

  it("le booster 'Permutation pure' est présent", () => {
    const result = resolve(input, "src/index.ts");
    expect(result.hunks[0].confidence.boosters.join(" ")).toMatch(/Permutation pure/);
  });
});

// ─── F22 — clés de config réorganisées ───────────────────────

describe("F22 — reorder_only : clés de config réorganisées (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `  debug: true,`,
    `  timeout: 5000,`,
    `  retries: 3,`,
    `||||||| base`,
    `  timeout: 5000,`,
    `  retries: 3,`,
    `  debug: true,`,
    `=======`,
    `  retries: 3,`,
    `  debug: true,`,
    `  timeout: 5000,`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en reorder_only", () => {
    const result = resolve(input, "src/config.ts");
    expect(result.hunks[0].type).toBe("reorder_only");
  });

  it("auto-résout", () => {
    const result = resolve(input, "src/config.ts");
    expect(result.stats.autoResolved).toBe(1);
  });
});

// ─── diff2 (sans base) ───────────────────────────────────────

describe("reorder_only sans base (diff2)", () => {
  const input = [
    `<<<<<<< ours`,
    `export { UserService };`,
    `export { AuthService };`,
    `export { LogService };`,
    `=======`,
    `export { LogService };`,
    `export { UserService };`,
    `export { AuthService };`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en reorder_only même sans base", () => {
    const result = resolve(input, "src/index.ts");
    expect(result.hunks[0].type).toBe("reorder_only");
  });

  it("auto-résout", () => {
    const result = resolve(input, "src/index.ts");
    expect(result.stats.autoResolved).toBe(1);
  });
});

// ─── Lignes dupliquées — pénalité ────────────────────────────

describe("reorder_only avec lignes dupliquées (F32-like)", () => {
  const input = [
    `<<<<<<< ours`,
    `foo`,
    `bar`,
    `foo`,
    `=======`,
    `bar`,
    `foo`,
    `foo`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en reorder_only (multiset égal)", () => {
    const result = resolve(input, "src/test.ts");
    expect(result.hunks[0].type).toBe("reorder_only");
  });

  it("applique la pénalité 'Lignes dupliquées'", () => {
    const result = resolve(input, "src/test.ts");
    const penalties = result.hunks[0].confidence.penalties.join(" ");
    expect(penalties).toMatch(/dupliqu/i);
  });

  it("le score est réduit par rapport au cas sans doublons", () => {
    const withDupResult = resolve(input, "src/test.ts");
    const noDupInput = [
      `<<<<<<< ours`,
      `foo`,
      `bar`,
      `baz`,
      `=======`,
      `baz`,
      `foo`,
      `bar`,
      `>>>>>>> theirs`,
    ].join("\n");
    const noDupResult = resolve(noDupInput, "src/test.ts");
    expect(withDupResult.hunks[0].confidence.score).toBeLessThan(
      noDupResult.hunks[0].confidence.score,
    );
  });
});

// ─── Faux positifs — ne doit PAS matcher ─────────────────────

describe("reorder_only : cas qui ne doivent pas matcher", () => {
  it("ne matche pas si une ligne est ajoutée", () => {
    const input = [
      `<<<<<<< ours`,
      `foo`,
      `bar`,
      `=======`,
      `bar`,
      `foo`,
      `baz`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/test.ts");
    expect(result.hunks[0].type).not.toBe("reorder_only");
  });

  it("ne matche pas si ours === theirs (same_change prend la main)", () => {
    const input = [
      `<<<<<<< ours`,
      `foo`,
      `bar`,
      `=======`,
      `foo`,
      `bar`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/test.ts");
    expect(result.hunks[0].type).toBe("same_change");
  });

  it("ne matche pas si les contenus sont vraiment différents", () => {
    const input = [
      `<<<<<<< ours`,
      `foo`,
      `bar`,
      `=======`,
      `baz`,
      `qux`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/test.ts");
    expect(result.hunks[0].type).not.toBe("reorder_only");
  });
});
