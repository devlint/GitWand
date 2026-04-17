/**
 * Tests du pattern insertion_at_boundary (v1.4)
 *
 * Fixtures :
 *   F23 — liste de dépendances npm (diff3, insertions distinctes)
 *   F24 — tableau de routes (diff3)
 * + cas diff2, chevauchement, faux positifs
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";

// ─── F23 — liste de dépendances (diff3) ──────────────────────

describe("F23 — insertion_at_boundary : liste de dépendances npm (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `  "lodash": "^4.17.21",`,
    `  "axios": "^1.6.0",`,
    `  "dayjs": "^1.11.10",`,
    `||||||| base`,
    `  "lodash": "^4.17.21",`,
    `  "axios": "^1.6.0",`,
    `=======`,
    `  "lodash": "^4.17.21",`,
    `  "axios": "^1.6.0",`,
    `  "zod": "^3.22.4",`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en insertion_at_boundary", () => {
    const result = resolve(input, "package.json");
    expect(result.hunks[0].type).toBe("insertion_at_boundary");
  });

  it("auto-résout avec haute confiance (diff3)", () => {
    const result = resolve(input, "package.json");
    expect(result.stats.autoResolved).toBe(1);
    expect(["high", "certain"]).toContain(result.hunks[0].confidence.label);
  });

  it("le résultat contient les insertions des deux côtés", () => {
    const result = resolve(input, "package.json");
    const merged = result.mergedContent!;
    expect(merged).toContain("dayjs");
    expect(merged).toContain("zod");
    expect(merged).toContain("lodash");
    expect(merged).toContain("axios");
  });

  it("le booster 'Insertions pures' est présent", () => {
    const result = resolve(input, "package.json");
    expect(result.hunks[0].confidence.boosters.join(" ")).toMatch(/Insertions pures/);
  });
});

// ─── F24 — tableau de routes (diff3) ─────────────────────────

describe("F24 — insertion_at_boundary : tableau de routes (diff3)", () => {
  const input = [
    `<<<<<<< ours`,
    `  { path: "/", component: Home },`,
    `  { path: "/about", component: About },`,
    `  { path: "/dashboard", component: Dashboard },`,
    `||||||| base`,
    `  { path: "/", component: Home },`,
    `  { path: "/about", component: About },`,
    `=======`,
    `  { path: "/", component: Home },`,
    `  { path: "/about", component: About },`,
    `  { path: "/settings", component: Settings },`,
    `>>>>>>> theirs`,
  ].join("\n");

  it("classifie en insertion_at_boundary", () => {
    const result = resolve(input, "src/router.ts");
    expect(result.hunks[0].type).toBe("insertion_at_boundary");
  });

  it("auto-résout", () => {
    const result = resolve(input, "src/router.ts");
    expect(result.stats.autoResolved).toBe(1);
  });

  it("les deux nouvelles routes sont présentes dans le résultat", () => {
    const result = resolve(input, "src/router.ts");
    const merged = result.mergedContent!;
    expect(merged).toContain("dashboard");
    expect(merged).toContain("settings");
  });
});

// ─── diff2 (sans base) — confiance réduite ───────────────────

// ─── diff2 (sans base) — heuristique stricte (sous-ensemble) ────────────────
// En diff2, insertion_at_boundary ne s'applique que si un côté est un strict
// sous-ensemble de l'autre (tailles différentes). Cas typique : ours a inséré
// une ligne de plus que theirs, ou vice versa.

describe("insertion_at_boundary sans base (diff2) — sous-ensemble strict", () => {
  // ours a ajouté PURPLE par rapport à theirs
  const input = [
    `<<<<<<< ours`,
    `  RED = "red",`,
    `  GREEN = "green",`,
    `  BLUE = "blue",`,
    `  PURPLE = "purple",`,
    `=======`,
    `  RED = "red",`,
    `  GREEN = "green",`,
    `  BLUE = "blue",`,
    `>>>>>>> theirs`,
  ].join("\n");
  // En diff2, la confiance est ~58 (medium) — nécessite minConfidence: "medium"
  const opts = { minConfidence: "medium" as const };

  it("classifie en insertion_at_boundary (heuristique diff2 — theirs ⊂ ours)", () => {
    const result = resolve(input, "src/colors.ts", opts);
    expect(result.hunks[0].type).toBe("insertion_at_boundary");
  });

  it("typeClassification inférieur au cas diff3 (confiance réduite)", () => {
    const result = resolve(input, "src/colors.ts", opts);
    expect(result.hunks[0].confidence.dimensions.typeClassification).toBeLessThan(90);
  });

  it("la pénalité 'Sans base (diff2)' est présente", () => {
    const result = resolve(input, "src/colors.ts", opts);
    expect(result.hunks[0].confidence.penalties.join(" ")).toMatch(/diff2/);
  });

  it("le résultat contient la ligne insérée par ours (avec minConfidence medium)", () => {
    const result = resolve(input, "src/colors.ts", opts);
    expect(result.stats.autoResolved).toBe(1);
    const merged = result.mergedContent!;
    expect(merged).toContain("RED");
    expect(merged).toContain("GREEN");
    expect(merged).toContain("BLUE");
    expect(merged).toContain("PURPLE");
  });
});

// ─── Chevauchement — doit tomber en complex ───────────────────

describe("insertion_at_boundary : chevauchement d'insertions → pas de match", () => {
  it("ne matche pas si les deux côtés ont inséré la même ligne", () => {
    const input = [
      `<<<<<<< ours`,
      `  foo,`,
      `  bar,`,
      `  shared,`,
      `||||||| base`,
      `  foo,`,
      `  bar,`,
      `=======`,
      `  foo,`,
      `  bar,`,
      `  shared,`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/test.ts");
    // same_change captera cela (ours === theirs)
    expect(result.hunks[0].type).toBe("same_change");
  });

  it("ne matche pas si un côté supprime par rapport à la base", () => {
    const input = [
      `<<<<<<< ours`,
      `  foo,`,
      `  newThing,`,
      `||||||| base`,
      `  foo,`,
      `  bar,`,
      `=======`,
      `  foo,`,
      `  bar,`,
      `  anotherThing,`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/test.ts");
    // ours supprime "bar" → pas une insertion pure
    expect(result.hunks[0].type).not.toBe("insertion_at_boundary");
  });
});

// ─── Relation avec non_overlapping ───────────────────────────

describe("insertion_at_boundary vs non_overlapping", () => {
  it("non_overlapping (prio 40) prend la main avant insertion_at_boundary (prio 57) quand le LCS réussit", () => {
    // Insertions à positions clairement différentes → LCS 3-way réussit → non_overlapping
    const input = [
      `<<<<<<< ours`,
      `  alpha,`,
      `  INSERTED_OURS,`,
      `  beta,`,
      `||||||| base`,
      `  alpha,`,
      `  beta,`,
      `=======`,
      `  alpha,`,
      `  beta,`,
      `  INSERTED_THEIRS,`,
      `>>>>>>> theirs`,
    ].join("\n");
    const result = resolve(input, "src/list.ts");
    expect(result.hunks[0].type).toBe("non_overlapping");
  });
});
