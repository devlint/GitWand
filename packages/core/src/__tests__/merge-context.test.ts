/**
 * accuracy lot C — Lot C : MergeContext.
 *
 * Le moteur reçoit (optionnellement) l'opération en cours et le côté cible.
 * Règles testées :
 *  - scalaire de version modifié des deux côtés + contexte → la cible gagne,
 *    y compris quand « le semver le plus élevé » aurait choisi l'autre côté ;
 *  - même cas sans contexte, valeurs non ordonnables → proposé, pas appliqué
 *    (l'ancien fallback politique était mesuré faux ~3 fois sur 4) ;
 *  - paires semver ordonnables sans contexte → règle historique intacte ;
 *  - hashes/timestamps → comportement inchangé, contexte ou pas ;
 *  - le contexte n'influence pas les hunks qui ne le concernent pas.
 */

import { describe, expect, it } from "vitest";
import { resolve, type MergeContext } from "../index.js";

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  ["<<<<<<< ours", ...ours, "||||||| base", ...base, "=======", ...theirs, ">>>>>>> theirs"].join("\n");

const backMerge: MergeContext = {
  operation: "merge",
  targetSide: "ours",
  oursRef: "13.x",
  theirsRef: "12.x",
};

describe("MergeContext — version scalars", () => {
  // Le cas laravel : la cible porte '13.x-dev' (non semver), la source une
  // version publiée. L'ancien moteur retombait sur prefer-theirs → importait
  // la version de la source. Les humains gardent TOUJOURS la valeur de la cible.
  const laravelShape = conflict(
    ["    const VERSION = '13.x-dev';"],
    ["    const VERSION = '12.53.0';"],
    ["    const VERSION = '12.54.1';"],
  );

  it("target wins on a back-merge, even against a 'newer' published version", () => {
    const result = resolve(laravelShape, "src/Application.php", { mergeContext: backMerge });
    expect(result.stats.autoResolved).toBe(1);
    expect(result.mergedContent).toContain("13.x-dev");
    expect(result.mergedContent).not.toContain("12.54.1");
    expect(result.resolutions[0].resolutionReason).toContain("target branch");
  });

  it("targetSide is honoured literally (rebase declares its own inversion)", () => {
    const rebaseCtx: MergeContext = { operation: "rebase", targetSide: "ours" };
    const result = resolve(laravelShape, "src/Application.php", { mergeContext: rebaseCtx });
    expect(result.mergedContent).toContain("13.x-dev");

    const inverted: MergeContext = { operation: "merge", targetSide: "theirs" };
    const result2 = resolve(laravelShape, "src/Application.php", { mergeContext: inverted });
    expect(result2.mergedContent).toContain("12.54.1");
  });

  it("without context, unorderable version pairs are proposed, never applied", () => {
    const result = resolve(laravelShape, "src/Application.php");
    expect(result.stats.autoResolved).toBe(0);
    expect(result.mergedContent).toBeNull();
    expect(result.resolutions[0].resolutionReason).toContain("decision");
  });

  it("orderable semver pairs keep 'newest wins' even WITH context", () => {
    // Mesuré sur benchmark/ : basculer aussi les paires ordonnables vers la
    // cible faisait régresser prettier (45,0 → 39,0 %) — les humains prennent
    // bien la dépendance la plus récente apportée par la branche source. La
    // règle « la cible gagne » ne s'applique qu'aux paires NON ordonnables
    // (l'identité de version du fichier : '13.x-dev', '2.9.0-dev'…).
    const orderable = conflict(
      ['  "version": "1.2.3"'],
      ['  "version": "1.2.2"'],
      ['  "version": "1.2.9"'],
    );
    const without = resolve(orderable, "app/config.json");
    expect(without.mergedContent).toContain("1.2.9");
    const withCtx = resolve(orderable, "app/config.json", { mergeContext: backMerge });
    expect(withCtx.mergedContent).toContain("1.2.9");
  });
});

describe("MergeContext — untouched behaviours", () => {
  it("hash-only value changes keep the policy fallback, context or not", () => {
    const hashes = conflict(
      ['  "sha": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"'],
      ['  "sha": "0000000000000000000000000000000000000000"'],
      ['  "sha": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"'],
    );
    const without = resolve(hashes, "meta.json");
    const withCtx = resolve(hashes, "meta.json", { mergeContext: backMerge });
    expect(without.mergedContent).toBe(withCtx.mergedContent);
    expect(without.stats.autoResolved).toBe(1);
  });

  it("context does not change hunks it cannot influence (one_side_change)", () => {
    const oneSide = conflict(["const x = 2;"], ["const x = 1;"], ["const x = 1;"]);
    const without = resolve(oneSide, "src/a.ts");
    const withCtx = resolve(oneSide, "src/a.ts", { mergeContext: backMerge });
    expect(without.mergedContent).toBe(withCtx.mergedContent);
    expect(without.hunks[0].type).toBe("one_side_change");
  });
});
