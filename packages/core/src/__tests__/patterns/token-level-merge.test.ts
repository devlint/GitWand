import { describe, it, expect } from "vitest";
import tokenLevelMerge from "../../patterns/token-level-merge.js";
import { classifyConflict } from "../../classifier.js";
import type { ClassifyInput } from "../../types.js";

function input(base: string[], ours: string[], theirs: string[]): ClassifyInput {
  return { baseLines: base, oursLines: ours, theirsLines: theirs, startLine: 1, endLine: base.length };
}

describe("token_level_merge : passe 1 — un seul côté change par ligne", () => {
  it("2 lignes adjacentes, chacune changée par un côté différent → résout", () => {
    const h = input(
      ['<div class="flex items-baseline gap-x-2 mr-2">', '<label class="font-weight-bold">'],
      ['<div class="flex items-baseline gap-x-2 mr-2">', '<label class="font-bold">'],
      ['<div class="flex items-baseline space-x-2 mr-2">', '<label class="font-weight-bold">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("3 lignes, ours change la 1ère, theirs change la 3ème, la 2ème est inchangée → résout", () => {
    const h = input(
      ["a 1", "b", "c 1"],
      ["a 2", "b", "c 1"],
      ["a 1", "b", "c 2"],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("1 seule ligne changée par theirs, reste identique → résout (équivalent one_side_change local)", () => {
    const h = input(["x", "y"], ["x", "y"], ["x", "z"]);
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("toutes les lignes changées, mais jamais les deux côtés sur la même ligne → résout", () => {
    const h = input(["a", "b", "c"], ["a2", "b", "c"], ["a", "b", "c2"]);
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("aucune ligne changée (contexte pur) → résout trivialement (toutes les lignes = base)", () => {
    const h = input(["a", "b"], ["a", "b"], ["a", "b"]);
    expect(tokenLevelMerge.detect(h)).toBe(false); // rien à proposer — voir Step 3 (pass1Count===0 && pass2Count===0)
  });
});

describe("token_level_merge : passe 2 — tokens disjoints sur une même ligne", () => {
  it('class="a b" → ours change \'a\', theirs change \'b\' (tokens disjoints) → résout', () => {
    const h = input(
      ['<div class="a b">'],
      ['<div class="a2 b">'],
      ['<div class="a b2">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("attribut différent en début et fin de balise, tokens disjoints → résout", () => {
    const h = input(
      ['<input type="text" name="foo" required>'],
      ['<input type="email" name="foo" required>'],
      ['<input type="text" name="foo" disabled>'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("deux lignes, chacune avec un conflit token-level résoluble → résout globalement", () => {
    const h = input(
      ['<div class="a b">', '<span id="x" data-foo="1">'],
      ['<div class="a2 b">', '<span id="x2" data-foo="1">'],
      ['<div class="a b2">', '<span id="x" data-foo="2">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("mélange passe 1 (ligne 1) + passe 2 (ligne 2) → résout", () => {
    const h = input(
      ["ctx", '<div class="a b">'],
      ["ctx-ours", '<div class="a2 b">'],
      ["ctx", '<div class="a b2">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });

  it("changement de valeur numérique isolée, tokens disjoints par construction → résout", () => {
    const h = input(
      ["width: 10px; height: 20px;"],
      ["width: 15px; height: 20px;"],
      ["width: 10px; height: 25px;"],
    );
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });
});

describe("token_level_merge : cas négatifs — doit échouer et retomber sur complex", () => {
  it("les deux côtés changent le MÊME token vers des valeurs différentes → échec", () => {
    const h = input(
      ['<div class="a b">'],
      ['<div class="a2 b">'],
      ['<div class="a3 b">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(false);
  });

  it("nombre de tokens différent entre ours et base sur une ligne en conflit → échec (pas de réalignement)", () => {
    const h = input(
      ['<div class="a b">'],
      ['<div class="a b c">'],
      ['<div class="a2 b">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(false);
  });

  it("une ligne a un vrai conflit alors que les autres sont résolubles → échec global (pas de résolution partielle)", () => {
    const h = input(
      ["ok", '<div class="a b">'],
      ["ok-ours", '<div class="a2 b">'],
      ["ok", '<div class="a3 b">'],
    );
    expect(tokenLevelMerge.detect(h)).toBe(false);
  });

  it("pas de base (diff2) → échec (requires: diff3)", () => {
    const h = input([], ['<div class="a2 b">'], ['<div class="a b2">']);
    expect(tokenLevelMerge.detect(h)).toBe(false);
  });

  it("nombre de lignes différent entre base/ours/theirs → échec (pas d'alignement 1:1 possible)", () => {
    const h = input(["a", "b"], ["a", "b", "c"], ["a", "b"]);
    expect(tokenLevelMerge.detect(h)).toBe(false);
  });
});

describe("token_level_merge : cache keyed par référence (robustesse à l'entrelacement)", () => {
  // Régression pour un finding de review : confidence()/explanation() lisaient
  // un `_lastResult` "dernier calculé", correct uniquement si aucun detect()
  // sur un AUTRE hunk ne s'intercale entre temps. Le cache est maintenant keyed
  // par référence sur l'input — un hunk différent en entrée force un recalcul
  // au lieu de retourner silencieusement le résultat d'un autre hunk.
  it("explanation() sur le hunk B après detect() sur le hunk A ne retourne pas le résultat de A", () => {
    const hunkA = input(
      ['<div class="a b">'],
      ['<div class="a2 b">'],
      ['<div class="a b2">'],
    ); // pass1: 0, pass2: 1
    const hunkB = input(
      ["ctx", '<div class="a b">'],
      ["ctx-ours", '<div class="a2 b">'],
      ["ctx", '<div class="a b2">'],
    ); // pass1: 1, pass2: 1

    expect(tokenLevelMerge.detect(hunkA)).toBe(true);
    // Ni detect(hunkB) ni classifyConflict(hunkB) n'ont été appelés ici — on
    // interroge directement explanation() sur hunkB. Avec un cache "dernier
    // calculé" non keyed, ceci retournerait à tort le pass1Count de hunkA (0).
    expect(tokenLevelMerge.explanation(hunkB)).toContain("1 ligne résolue");
    // Et repasser sur hunkA doit toujours donner le résultat de hunkA, pas
    // celui de hunkB qu'on vient d'interroger.
    expect(tokenLevelMerge.explanation(hunkA)).toContain("0 lignes résolues");
  });

  it("explanation() sur un hunk jamais passé par detect() calcule quand même le bon résultat", () => {
    const neverDetected = input(
      ["ctx", '<div class="a b">'],
      ["ctx-ours", '<div class="a2 b">'],
      ["ctx", '<div class="a b2">'],
    ); // pass1: 1, pass2: 1
    expect(tokenLevelMerge.explanation(neverDetected)).toContain("1 ligne résolue");
    expect(tokenLevelMerge.explanation(neverDetected)).toContain("1 ligne fusionnée");
  });
});

describe("token_level_merge : intégration classifier", () => {
  it("classifie en token_level_merge et attache tokenMergeTrace", () => {
    const h = input(
      ['<div class="a b">'],
      ['<div class="a2 b">'],
      ['<div class="a b2">'],
    );
    const result = classifyConflict(h);
    expect(result.type).toBe("token_level_merge");
    expect(result.trace.tokenMergeTrace).not.toBeUndefined();
    expect(result.trace.tokenMergeTrace?.mergedLines).toEqual(['<div class="a2 b2">']);
    expect(result.trace.tokenMergeTrace?.pass2Count).toBe(1);
  });

  it("deux lignes, un vrai conflit token-level par ligne (both-sides-changed) → token_level_merge, pas non_overlapping", () => {
    // Contrairement au cas "un seul côté par ligne" (déjà couvert par non_overlapping —
    // vérifié empiriquement : LCS 3-way le résout sans notre pattern), ce cas a les DEUX
    // côtés qui modifient chacune des deux lignes → non_overlapping échoue (chevauchement
    // réel), seul token_level_merge peut le résoudre via la passe 2 (tokens disjoints).
    const h = input(
      ['<div class="a b">', '<label class="c d">'],
      ['<div class="a2 b">', '<label class="c d2">'],
      ['<div class="a b2">', '<label class="c2 d">'],
    );
    const result = classifyConflict(h);
    expect(result.type).toBe("token_level_merge");
    expect(result.trace.tokenMergeTrace?.pass2Count).toBe(2);
  });
});
