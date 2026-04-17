/**
 * Tests de confiance v1.4
 *
 * Fixtures :
 *   F31 — zdiff3 : détection et ajustement `baseAvailability`
 *   F32 — reorder_only avec lignes dupliquées (pénalité −10)
 *
 * Également :
 *   - Vérification des nouvelles dimensions (fileFrequency, baseAvailability)
 *   - Pénalité fileFrequency sur les fichiers "zone chaude"
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../resolver.js";
import { toConflictHunk } from "../parser.js";

// ─── F31 — zdiff3 détection ───────────────────────────────────

describe("F31 — zdiff3 : détection et baseAvailability", () => {
  // En zdiff3, la section base ne montre que les lignes divergentes.
  // Ici, ours a ajouté "REDIS_URL" et theirs a ajouté "SMTP_HOST".
  // La base (zdiff3) ne montre que "APP_NAME" (ligne commune aux deux).
  // → base est un sous-ensemble de ours ET de theirs → zdiff3 détecté.
  const zdiff3Input = [
    `<<<<<<< ours`,
    `APP_NAME=my-app`,
    `DATABASE_URL=postgres://localhost/db`,
    `REDIS_URL=redis://localhost:6379`,
    `||||||| base`,
    `APP_NAME=my-app`,
    `=======`,
    `APP_NAME=my-app`,
    `DATABASE_URL=postgres://localhost/db`,
    `SMTP_HOST=smtp.example.com`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("résout le conflit (insertion_at_boundary ou dotenv)", () => {
    const result = resolve(zdiff3Input, ".env");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le hunk a zdiff3: true", () => {
    const result = resolve(zdiff3Input, ".env");
    expect(result.hunks[0].zdiff3).toBe(true);
  });

  it("la dimension baseAvailability est 100", () => {
    const result = resolve(zdiff3Input, ".env");
    expect(result.hunks[0].confidence.dimensions.baseAvailability).toBe(100);
  });

  it("le booster mentionne zdiff3", () => {
    const result = resolve(zdiff3Input, ".env");
    const boosters = result.hunks[0].confidence.boosters;
    expect(boosters.some((b) => b.toLowerCase().includes("zdiff3"))).toBe(true);
  });

  it("diff2 n'a pas zdiff3:true", () => {
    const diff2Input = [
      `<<<<<<< ours`,
      `APP_NAME=my-app`,
      `REDIS_URL=redis://localhost:6379`,
      `=======`,
      `APP_NAME=my-app`,
      `SMTP_HOST=smtp.example.com`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(diff2Input, ".env");
    expect(result.hunks[0].zdiff3).toBeUndefined();
  });

  it("diff3 complet n'a pas zdiff3:true (base contient des lignes hors ours ET hors theirs)", () => {
    // Base a une ligne qui n'est dans aucun des deux côtés (supprimée des deux)
    const full3Input = [
      `<<<<<<< ours`,
      `A=1`,
      `C=3`,
      `||||||| base`,
      `A=1`,
      `B=2`,
      `C=3`,
      `=======`,
      `A=1`,
      `C=3`,
      `D=4`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(full3Input, "config.env");
    // "B=2" est dans la base mais pas dans ours ni theirs → pas un sous-ensemble → pas zdiff3
    expect(result.hunks[0].zdiff3).toBeUndefined();
  });
});

// ─── zdiff3 avec toConflictHunk directement ───────────────────

describe("zdiff3 — toConflictHunk direct", () => {
  it("détecte zdiff3 quand base ⊆ ours", () => {
    const hunk = toConflictHunk({
      oursLines:   ["A=1", "B=2", "C=3"],
      baseLines:   ["A=1"],             // base ⊆ ours
      theirsLines: ["X=9", "Y=8"],
      startLine: 1,
      endLine: 7,
    });
    expect(hunk.zdiff3).toBe(true);
    expect(hunk.confidence.dimensions.baseAvailability).toBe(100);
  });

  it("détecte zdiff3 quand base ⊆ theirs", () => {
    const hunk = toConflictHunk({
      oursLines:   ["X=9", "Y=8"],
      baseLines:   ["Y=8"],             // base ⊆ theirs
      theirsLines: ["X=9", "Y=8", "Z=7"],
      startLine: 1,
      endLine: 7,
    });
    expect(hunk.zdiff3).toBe(true);
    expect(hunk.confidence.dimensions.baseAvailability).toBe(100);
  });

  it("ne détecte pas zdiff3 quand base contient des lignes hors ours et theirs", () => {
    const hunk = toConflictHunk({
      oursLines:   ["A=1"],
      baseLines:   ["A=1", "DELETED=old"],   // DELETED n'est ni dans ours ni dans theirs
      theirsLines: ["A=1", "B=2"],
      startLine: 1,
      endLine: 8,
    });
    expect(hunk.zdiff3).toBeUndefined();
    expect(hunk.confidence.dimensions.baseAvailability).toBe(0);
  });

  it("ne détecte pas zdiff3 quand baseLines est vide (diff2)", () => {
    const hunk = toConflictHunk({
      oursLines:   ["A=1"],
      baseLines:   [],
      theirsLines: ["B=2"],
      startLine: 1,
      endLine: 5,
    });
    expect(hunk.zdiff3).toBeUndefined();
  });
});

// ─── F32 — reorder_only avec lignes dupliquées ────────────────

describe("F32 — reorder_only : lignes dupliquées (pénalité ordre ambigu)", () => {
  // Ours et theirs ont les mêmes lignes (même multiset) mais dans des ordres différents.
  // La ligne "export { A }" apparaît deux fois → lignes dupliquées → pénalité appliquée.
  const input = [
    `<<<<<<< ours`,
    `export { A } from "./a";`,
    `export { A } from "./a";`,
    `export { B } from "./b";`,
    `export { C } from "./c";`,
    `=======`,
    `export { B } from "./b";`,
    `export { C } from "./c";`,
    `export { A } from "./a";`,
    `export { A } from "./a";`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en reorder_only", () => {
    const result = resolve(input, "index.ts");
    // Vérifier que c'est bien reorder_only (pas intercepté par imports resolver
    // car c'est des `export` pas des `import`)
    const hunk = result.hunks[0];
    expect(hunk.type).toBe("reorder_only");
  });

  it("auto-résout (malgré les doublons)", () => {
    const result = resolve(input, "index.ts");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("la pénalité de doublons est mentionnée", () => {
    const result = resolve(input, "index.ts");
    const penalties = result.hunks[0].confidence.penalties;
    expect(penalties.some((p) => p.toLowerCase().includes("dupliqu"))).toBe(true);
  });

  it("le score est inférieur à un reorder_only sans doublons", () => {
    // Sans doublons
    const inputClean = [
      `<<<<<<< ours`,
      `export { A } from "./a";`,
      `export { B } from "./b";`,
      `export { C } from "./c";`,
      `=======`,
      `export { B } from "./b";`,
      `export { C } from "./c";`,
      `export { A } from "./a";`,
      `>>>>>>> theirs`,
    ].join("\n");
    const cleanResult  = resolve(inputClean, "index.ts");
    const dupResult    = resolve(input,      "index.ts");
    const cleanScore = cleanResult.hunks[0].confidence.score;
    const dupScore   = dupResult.hunks[0].confidence.score;
    expect(dupScore).toBeLessThan(cleanScore);
  });
});

// ─── Nouvelles dimensions — vérification structure ────────────

describe("ConfidenceScore v1.4 — dimensions fileFrequency et baseAvailability", () => {
  it("un hunk normal a fileFrequency = 0 et baseAvailability = 0", () => {
    const simpleInput = [
      `<<<<<<< ours`,
      `const x = 1;`,
      `=======`,
      `const x = 2;`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(simpleInput, "foo.ts");
    const dims = result.hunks[0].confidence.dimensions;
    expect(dims.fileFrequency).toBe(0);
    expect(dims.baseAvailability).toBe(0);
  });

  it("un hunk diff3 plein n'est pas zdiff3 (base contient une ligne absente des deux côtés)", () => {
    // La base contient "OLD_KEY=deleted" qui a été supprimé des deux côtés.
    // base n'est pas un sous-ensemble de ours (OLD_KEY absent de ours),
    // ni de theirs (OLD_KEY absent de theirs) → pas zdiff3.
    const diff3Input = [
      `<<<<<<< ours`,
      `FOO=bar`,
      `NEW_KEY=value`,
      `||||||| base`,
      `FOO=bar`,
      `OLD_KEY=deleted`,
      `=======`,
      `FOO=baz`,
      `OTHER=thing`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(diff3Input, "config.env");
    const dims = result.hunks[0].confidence.dimensions;
    // "OLD_KEY=deleted" dans la base n'est ni dans ours ni dans theirs → pas zdiff3
    expect(dims.baseAvailability).toBe(0);
    expect(result.hunks[0].zdiff3).toBeUndefined();
  });
});

// ─── fileFrequency — pénalité zone chaude ────────────────────

describe("fileFrequency — pénalité sur les fichiers avec hunks complexes", () => {
  it("le second hunk d'un fichier chaud reçoit une pénalité fileFrequency", () => {
    // Deux conflits dans le même fichier :
    // - hunk 1 : complexe (non résolu)
    // - hunk 2 : whitespace_only (auto-résolu mais dans un fichier "chaud")
    const input = [
      `<<<<<<< ours`,
      `function foo() {`,
      `  return 1;`,
      `}`,
      `=======`,
      `function foo() {`,
      `  return 2; // changed`,
      `}`,
      `>>>>>>> theirs`,
      ``,
      `// between conflicts`,
      ``,
      `<<<<<<< ours`,
      `const bar = 1;`,
      `=======`,
      `const bar = 1;`,
      `>>>>>>> theirs`,
    ].join("\n");

    const result = resolve(input, "example.ts");

    // Le premier hunk est complexe (non résolu)
    expect(result.hunks[0].type).toBe("complex");
    expect(result.resolutions[0].autoResolved).toBe(false);

    // Le second hunk (same_change) devrait avoir fileFrequency > 0
    expect(result.hunks[1].confidence.dimensions.fileFrequency).toBe(20);
  });

  it("la pénalité est mentionnée dans les penalties du hunk chaud", () => {
    const input = [
      `<<<<<<< ours`,
      `function complex() { return 1; }`,
      `=======`,
      `function complex() { return 2; }`,
      `>>>>>>> theirs`,
      ``,
      `<<<<<<< ours`,
      `const x = 1;`,
      `=======`,
      `const x = 1;`,
      `>>>>>>> theirs`,
    ].join("\n");

    const result = resolve(input, "hot.ts");
    const secondHunkPenalties = result.hunks[1].confidence.penalties;
    expect(secondHunkPenalties.some((p) => p.toLowerCase().includes("zone chaude"))).toBe(true);
  });

  it("un seul hunk dans un fichier n'a pas de pénalité fileFrequency", () => {
    const input = [
      `<<<<<<< ours`,
      `const x = 1;`,
      `=======`,
      `const x = 1;`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "single.ts");
    expect(result.hunks[0].confidence.dimensions.fileFrequency).toBe(0);
  });
});
