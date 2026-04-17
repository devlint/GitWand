/**
 * Tests du resolver .env (v1.4)
 *
 * Fixtures :
 *   F28 — clés ajoutées des deux côtés
 *   F29 — même clé, valeur différente → prefer theirs
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F28 — clés ajoutées des deux côtés ──────────────────────

describe("F28 — .env : clés ajoutées des deux côtés (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `APP_NAME=my-app`,
    `DATABASE_URL=postgres://localhost/db`,
    `REDIS_URL=redis://localhost:6379`,
    `||||||| base`,
    `APP_NAME=my-app`,
    `DATABASE_URL=postgres://localhost/db`,
    `=======`,
    `APP_NAME=my-app`,
    `DATABASE_URL=postgres://localhost/db`,
    `SMTP_HOST=smtp.example.com`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver dotenv", () => {
    const result = resolve(input, ".env");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les clés des deux côtés", () => {
    const result = resolve(input, ".env");
    const merged = result.mergedContent!;
    expect(merged).toContain("REDIS_URL");
    expect(merged).toContain("SMTP_HOST");
    expect(merged).toContain("APP_NAME");
    expect(merged).toContain("DATABASE_URL");
  });

  it("la raison mentionne [dotenv]", () => {
    const result = resolve(input, ".env");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dotenv\]/i);
  });
});

// ─── F29 — même clé, valeur différente ───────────────────────

describe("F29 — .env : conflit de valeur sur la même clé (prefer theirs)", () => {
  const input = [
    `<<<<<<< ours`,
    `APP_ENV=staging`,
    `API_KEY=ours-key-12345`,
    `=======`,
    `APP_ENV=production`,
    `API_KEY=theirs-key-67890`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout (prefer theirs)", () => {
    const result = resolve(input, ".env.production");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("les valeurs de theirs sont retenues", () => {
    const result = resolve(input, ".env.production");
    const merged = result.mergedContent!;
    expect(merged).toContain("production");
    expect(merged).toContain("theirs-key-67890");
    expect(merged).not.toContain("staging");
    expect(merged).not.toContain("ours-key-12345");
  });
});

// ─── Détection du nom de fichier ─────────────────────────────

describe("dotenv — détection des noms de fichier", () => {
  const simpleInput = [
    `<<<<<<< ours`,
    `FOO=bar`,
    `=======`,
    `FOO=baz`,
    `>>>>>>> theirs`,
  ].join("\n");

  it(".env est détecté", () => {
    const result = resolve(simpleInput, ".env");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dotenv\]/i);
  });

  it(".env.local est détecté", () => {
    const result = resolve(simpleInput, ".env.local");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dotenv\]/i);
  });

  it(".env.production est détecté", () => {
    const result = resolve(simpleInput, ".env.production");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dotenv\]/i);
  });

  it("app.env est détecté", () => {
    const result = resolve(simpleInput, "config/app.env");
    expect(result.resolutions[0].resolutionReason).toMatch(/\[dotenv\]/i);
  });
});

// ─── Lignes vides et commentaires ────────────────────────────

describe("dotenv — préservation des commentaires", () => {
  it("résout sans erreur quand des commentaires sont présents", () => {
    const input = [
      `<<<<<<< ours`,
      `# Application settings`,
      `APP_NAME=my-app`,
      `DEBUG=true`,
      `=======`,
      `# Application settings`,
      `APP_NAME=my-app`,
      `LOG_LEVEL=info`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, ".env");
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("DEBUG");
    expect(result.mergedContent).toContain("LOG_LEVEL");
  });
});
