# Pattern `token_level_merge` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new conflict-resolution pattern, `token_level_merge`, that decomposes a
multi-line hunk line-by-line and, for lines where both sides still diverge, merges disjoint
token-level changes — always surfaced to the user as a confirm/reject proposal, never
auto-applied.

**Architecture:** Pure addition to `packages/core`'s pattern registry (new `ConflictType`,
new `PatternPlugin`, one `classifier.ts` registration, one `assemble.ts` case) plus a new Vue
panel in `apps/desktop` wired through the existing `resolveHunkCustom` emit — the same pathway
already used by manual edits and AI suggestions. No Rust changes (see Global Constraints).

**Tech Stack:** TypeScript (`packages/core`, Vitest), Vue 3 `<script setup>`
(`apps/desktop/src`).

## Global Constraints

- `packages/core` : zéro dépendance Node.js — le nouveau pattern est du TS pur, réutilise
  `tokenizeLine()` déjà exporté par `patterns/utils.ts`.
- **Aucun changement Rust n'est nécessaire.** Vérifié directement dans le code : le "parity
  probe" (`apps/desktop/src-tauri/examples/parity_probe.rs`) et `pnpm test:parity`
  (`apps/desktop/tests/parity/*.test.mjs`) comparent des commandes git (status/log/branches/
  stash/submodule) entre Rust et le dev-server Node — jamais la logique de classification de
  conflits. Le moteur de résolution vit uniquement en TypeScript et est consommé directement
  par le frontend Vue via `@gitwand/core`. (`apps/desktop/CLAUDE.md` contient une description
  obsolète de ce probe — hors périmètre de ce plan, signalé séparément.)
- Diff parsing : toute nouvelle logique qui lit des lignes de hunk doit respecter la règle des
  lignes de contexte (`line.startsWith(' ')`) — non applicable ici car le pattern consomme des
  `ClassifyInput.{base,ours,theirs}Lines` déjà extraites, pas le diff brut.
- i18n : toute string visible ajoutée doit exister dans les 5 locales
  (`en`, `fr`, `es`, `pt-br`, `zh-cn`) sous `apps/desktop/src/locales/`.
- Tests : minimum 15 cas pour le nouveau pattern (règle `packages/core/CLAUDE.md` : 10 minimum,
  renforcé ici car deux sous-mécaniques distinctes).
- Ne jamais éditer les fichiers de version à la main (non applicable — pas de bump ici).

---

### Task 1: `ConflictType` + types de trace pour la proposition

**Files:**
- Modify: `packages/core/src/types.ts:28` (insertion dans l'union `ConflictType`)
- Modify: `packages/core/src/types.ts:299` (ajout du champ optionnel sur `DecisionTrace`)
- Test: `packages/core/src/__tests__/types.test.ts` (nouveau fichier — test de compilation/forme)

**Interfaces:**
- Produces: `ConflictType` inclut désormais `"token_level_merge"`. Nouveaux types exportés
  `TokenMergeLineDetail` et `TokenMergeTrace`, et `DecisionTrace.tokenMergeTrace?: TokenMergeTrace`.

- [ ] **Step 1: Écrire le test qui vérifie la forme du nouveau type**

```typescript
// packages/core/src/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import type { ConflictType, DecisionTrace, TokenMergeTrace } from "../types.js";

describe("types : token_level_merge", () => {
  it("ConflictType accepte 'token_level_merge'", () => {
    const t: ConflictType = "token_level_merge";
    expect(t).toBe("token_level_merge");
  });

  it("DecisionTrace peut porter un tokenMergeTrace optionnel", () => {
    const trace: DecisionTrace = {
      steps: [],
      selected: "token_level_merge",
      summary: "test",
      hasBase: true,
      tokenMergeTrace: {
        mergedLines: ["a", "b"],
        pass1Count: 1,
        pass2Count: 1,
        lineDetails: [
          { lineIndex: 0, resolvedBy: "pass1", resolvedLine: "a" },
          { lineIndex: 1, resolvedBy: "pass2", resolvedLine: "b" },
        ],
      },
    };
    expect(trace.tokenMergeTrace?.mergedLines).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue (erreur de compilation TS)**

Run: `cd packages/core && pnpm vitest run src/__tests__/types.test.ts`
Expected: FAIL — `Type '"token_level_merge"' is not assignable to type 'ConflictType'` (ou
erreur équivalente sur `tokenMergeTrace`/`TokenMergeTrace` introuvable).

- [ ] **Step 3: Ajouter le type au fichier `types.ts`**

Dans `packages/core/src/types.ts`, remplacer (ligne ~21-33) :

```typescript
export type ConflictType =
  | "one_side_change"           // Seul un côté a modifié par rapport à la base
  | "same_change"               // Les deux côtés ont fait la même modification
  | "non_overlapping"           // Ajouts à des endroits différents (ex: imports)
  | "whitespace_only"           // Différences de whitespace uniquement
  | "delete_no_change"          // Un côté supprime, l'autre n'a pas touché
  | "generated_file"            // Fichier auto-généré (lock, manifest, min.js…)
  | "value_only_change"         // Même structure, seule une valeur change (hash, version, timestamp…)
  | "reorder_only"              // v1.4 — mêmes lignes, ordre différent (permutation pure)
  | "insertion_at_boundary"     // v1.4 — insertions pures des deux côtés, base intacte
  | "llm_proposed"              // v2.5 — résolution proposée par LLM fallback (opt-in, priority 998)
  | "refactoring_aware_merge"  // v2.6 — RefMerge : détection/inversion/rejeu de refactorings (expérimental, opt-in)
  | "complex";                  // Conflit réel nécessitant intervention humaine
```

par :

```typescript
export type ConflictType =
  | "one_side_change"           // Seul un côté a modifié par rapport à la base
  | "same_change"               // Les deux côtés ont fait la même modification
  | "non_overlapping"           // Ajouts à des endroits différents (ex: imports)
  | "whitespace_only"           // Différences de whitespace uniquement
  | "delete_no_change"          // Un côté supprime, l'autre n'a pas touché
  | "generated_file"            // Fichier auto-généré (lock, manifest, min.js…)
  | "value_only_change"         // Même structure, seule une valeur change (hash, version, timestamp…)
  | "reorder_only"              // v1.4 — mêmes lignes, ordre différent (permutation pure)
  | "insertion_at_boundary"     // v1.4 — insertions pures des deux côtés, base intacte
  | "token_level_merge"        // v2.7 — fusion fine ligne/token, toujours proposée (jamais auto-appliquée)
  | "llm_proposed"              // v2.5 — résolution proposée par LLM fallback (opt-in, priority 998)
  | "refactoring_aware_merge"  // v2.6 — RefMerge : détection/inversion/rejeu de refactorings (expérimental, opt-in)
  | "complex";                  // Conflit réel nécessitant intervention humaine
```

Puis, juste avant l'interface `DecisionTrace` (repérer le commentaire `// ─── Phase v2.6 —
Refactoring-aware merge ────────────────────` ou équivalent en amont de la ligne ~286), ajouter :

```typescript
// ─── v2.7 — Token-level merge (proposition, jamais auto-appliquée) ──────

/** Détail de résolution pour une ligne du hunk. */
export interface TokenMergeLineDetail {
  /** Index de la ligne dans le hunk (0-based, aligné sur base/ours/theirs). */
  lineIndex: number;
  /** Quelle passe a résolu cette ligne. */
  resolvedBy: "pass1" | "pass2";
  /** Contenu final proposé pour cette ligne. */
  resolvedLine: string;
  /** Indices de tokens modifiés par ours (uniquement renseigné pour pass2). */
  oursTokenIndices?: number[];
  /** Indices de tokens modifiés par theirs (uniquement renseigné pour pass2). */
  theirsTokenIndices?: number[];
}

/** Proposition complète de fusion token-level pour un hunk. */
export interface TokenMergeTrace {
  /** Lignes fusionnées proposées — appliquées telles quelles si l'utilisateur accepte. */
  mergedLines: string[];
  /** Nombre de lignes résolues par la passe 1 (décomposition ligne-par-ligne). */
  pass1Count: number;
  /** Nombre de lignes résolues par la passe 2 (diff token-level). */
  pass2Count: number;
  /** Détail par ligne, pour l'annotation visuelle dans le panneau de proposition. */
  lineDetails: TokenMergeLineDetail[];
}
```

Puis modifier l'interface `DecisionTrace` (ligne ~286-300) pour ajouter le champ :

```typescript
export interface DecisionTrace {
  steps: TraceStep[];
  selected: ConflictType;
  summary: string;
  hasBase: boolean;
  llmTrace?: LlmTrace;
  /**
   * v2.7 — Proposition de fusion token-level (uniquement si
   * `selected === "token_level_merge"`). `undefined` pour tous les autres types.
   */
  tokenMergeTrace?: TokenMergeTrace;
}
```

- [ ] **Step 4: Relancer le test pour vérifier qu'il passe**

Run: `cd packages/core && pnpm vitest run src/__tests__/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Vérifier que le build TS global ne casse rien**

Run: `cd packages/core && pnpm build`
Expected: exit code 0, pas d'erreur de type dans les fichiers existants (le `switch` de
`assemble.ts` n'a pas de garde d'exhaustivité, donc aucune erreur attendue à ce stade — le
`case` sera ajouté au Task 4).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/types.test.ts
git commit -m "feat(core): add token_level_merge ConflictType and trace types"
```

---

### Task 2: Implémenter le pattern `token-level-merge.ts`

**Files:**
- Create: `packages/core/src/patterns/token-level-merge.ts`
- Test: `packages/core/src/__tests__/patterns/token-level-merge.test.ts`

**Interfaces:**
- Consumes: `ClassifyInput { oursLines, baseLines, theirsLines, startLine, endLine }`
  (`types.ts`), `tokenizeLine(line: string): string[]` et `makeScore(...)`/`scopeImpact(...)`
  (`patterns/utils.ts`), `TokenMergeTrace`/`TokenMergeLineDetail` (Task 1).
- Produces: `default: PatternPlugin` avec `type: "token_level_merge"`. Exporte aussi
  `getLastTokenMergeResult(): TokenMergeTrace | null` (cache module-level, lu par
  `classifier.ts` au Task 3 et par `assemble.ts` — pattern identique à
  `getLastRefMergeResult()` dans `refactoring-aware-merge.ts`).

**Algorithme (décidé pendant ce plan, simplification volontaire vs le spec) :** la passe 2
compare les tokens **positionnellement** (pas de réalignement LCS) — si `tokenizeLine(ours[i])`
et `tokenizeLine(theirs[i])` ont le même nombre de tokens que `tokenizeLine(base[i])`, on
compare index par index. Si un token a changé des deux côtés vers des valeurs différentes au
même index → vrai conflit, la ligne échoue. Sinon on prend le token modifié (ours ou theirs) ou
le token de base si aucun des deux n'a changé. Si les comptes de tokens diffèrent entre
base/ours/theirs → la ligne échoue (pas de réalignement, cas hors périmètre v1). Ceci couvre le
cas cible (changement de valeur d'attribut, même nombre de tokens) sans les risques d'un
réalignement LCS token-level.

- [ ] **Step 1: Écrire les tests (passe 1 seule — 5 cas)**

```typescript
// packages/core/src/__tests__/patterns/token-level-merge.test.ts
import { describe, it, expect } from "vitest";
import tokenLevelMerge from "../../patterns/token-level-merge.js";
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
    expect(tokenLevelMerge.detect(h)).toBe(true);
  });
});

describe("token_level_merge : passe 2 — tokens disjoints sur une même ligne", () => {
  it("class=\"a b\" → ours change 'a', theirs change 'b' (tokens disjoints) → résout", () => {
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
    // Remarque : "required" -> "disabled" a un nombre de tokens différent après
    // tokenizeLine si la longueur de mot change la position des séparateurs ;
    // ce cas garde le même nombre de tokens (remplacement mot-à-mot).
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
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent (module introuvable)**

Run: `cd packages/core && pnpm vitest run src/__tests__/patterns/token-level-merge.test.ts`
Expected: FAIL — `Cannot find module '../../patterns/token-level-merge.js'`.

- [ ] **Step 3: Implémenter le pattern**

```typescript
// packages/core/src/patterns/token-level-merge.ts
import type { ClassifyInput, ConfidenceScore, PatternPlugin, TokenMergeTrace, TokenMergeLineDetail } from "../types.js";
import { makeScore, scopeImpact, tokenizeLine } from "./utils.js";

/** Cache module-level du dernier résultat calculé par detect(). */
let _lastResult: TokenMergeTrace | null = null;

/** Retourne le dernier résultat mis en cache par detect() (lu par classifier.ts et assemble.ts). */
export function getLastTokenMergeResult(): TokenMergeTrace | null {
  return _lastResult;
}

/**
 * Tente de résoudre une seule ligne en conflit (base/ours/theirs différents).
 * Retourne le detail de résolution si réussi, `null` si conflit réel ou tokens non alignés.
 */
function resolveConflictedLine(
  lineIndex: number,
  base: string,
  ours: string,
  theirs: string,
): TokenMergeLineDetail | null {
  const baseTokens = tokenizeLine(base);
  const oursTokens = tokenizeLine(ours);
  const theirsTokens = tokenizeLine(theirs);

  if (oursTokens.length !== baseTokens.length || theirsTokens.length !== baseTokens.length) {
    return null; // Pas de réalignement — hors périmètre v1.
  }

  const merged: string[] = [];
  const oursTokenIndices: number[] = [];
  const theirsTokenIndices: number[] = [];

  for (let j = 0; j < baseTokens.length; j++) {
    const oursChanged = oursTokens[j] !== baseTokens[j];
    const theirsChanged = theirsTokens[j] !== baseTokens[j];

    if (oursChanged && theirsChanged) {
      if (oursTokens[j] !== theirsTokens[j]) {
        return null; // Vrai conflit sur ce token — la ligne échoue.
      }
      merged.push(oursTokens[j]); // Même changement des deux côtés.
    } else if (oursChanged) {
      merged.push(oursTokens[j]);
      oursTokenIndices.push(j);
    } else if (theirsChanged) {
      merged.push(theirsTokens[j]);
      theirsTokenIndices.push(j);
    } else {
      merged.push(baseTokens[j]);
    }
  }

  return {
    lineIndex,
    resolvedBy: "pass2",
    resolvedLine: merged.join(""),
    oursTokenIndices,
    theirsTokenIndices,
  };
}

/**
 * Calcule la proposition complète de fusion pour le hunk, ou `null` si une
 * ligne au moins résiste (échec global — pas de résolution partielle).
 */
function computeTokenMerge(h: ClassifyInput): TokenMergeTrace | null {
  if (h.baseLines.length === 0) return null; // requires: diff3
  if (h.oursLines.length !== h.baseLines.length || h.theirsLines.length !== h.baseLines.length) {
    return null; // Pas d'alignement 1:1 possible.
  }

  const mergedLines: string[] = [];
  const lineDetails: TokenMergeLineDetail[] = [];
  let pass1Count = 0;
  let pass2Count = 0;

  for (let i = 0; i < h.baseLines.length; i++) {
    const base = h.baseLines[i];
    const ours = h.oursLines[i];
    const theirs = h.theirsLines[i];

    if (ours === base && theirs === base) {
      mergedLines.push(base); // Contexte pur.
      continue;
    }
    if (ours === base && theirs !== base) {
      mergedLines.push(theirs);
      lineDetails.push({ lineIndex: i, resolvedBy: "pass1", resolvedLine: theirs });
      pass1Count++;
      continue;
    }
    if (theirs === base && ours !== base) {
      mergedLines.push(ours);
      lineDetails.push({ lineIndex: i, resolvedBy: "pass1", resolvedLine: ours });
      pass1Count++;
      continue;
    }

    // Les deux côtés diffèrent de la base sur cette ligne — passe 2.
    const resolved = resolveConflictedLine(i, base, ours, theirs);
    if (resolved === null) return null; // Échec global.
    mergedLines.push(resolved.resolvedLine);
    lineDetails.push(resolved);
    pass2Count++;
  }

  if (pass2Count === 0 && pass1Count === 0) return null; // Rien à proposer (aucun conflit réel — ne devrait pas arriver ici, patterns amont l'auraient déjà résolu).

  return { mergedLines, pass1Count, pass2Count, lineDetails };
}

const tokenLevelMerge: PatternPlugin = {
  type: "token_level_merge",
  priority: 65,
  requires: "diff3",

  detect(h: ClassifyInput): boolean {
    _lastResult = computeTokenMerge(h);
    return _lastResult !== null;
  },

  confidence(_h: ClassifyInput): ConfidenceScore {
    const totalLines = _lastResult ? _lastResult.mergedLines.length : 0;
    // dataRisk volontairement non-nul : ce pattern ne doit JAMAIS s'auto-appliquer,
    // quel que soit le score obtenu (cf. resolver/assemble.ts — case dédié).
    return makeScore(70, 38, scopeImpact(totalLines), [
      "Décomposition ligne-par-ligne et token-level réussie",
    ], [
      "Résolution proposée — jamais auto-appliquée, confirmation utilisateur requise",
    ]);
  },

  explanation(_h: ClassifyInput): string {
    if (!_lastResult) return "Fusion token-level proposée.";
    const { pass1Count, pass2Count } = _lastResult;
    return `Fusion proposée : ${pass1Count} ligne${pass1Count === 1 ? "" : "s"} résolue${pass1Count === 1 ? "" : "s"} ligne-par-ligne, ${pass2Count} ligne${pass2Count === 1 ? "" : "s"} fusionnée${pass2Count === 1 ? "" : "s"} token-par-token. Confirmation requise avant application.`;
  },

  passReason(_h: ClassifyInput): string {
    return "Décomposition ligne-par-ligne + diff token-level réussis sur toutes les lignes du hunk.";
  },

  failReason(_h: ClassifyInput): string {
    return "Au moins une ligne résiste (vrai conflit token-level ou désalignement de tokens) — pas de résolution partielle.";
  },
};

export default tokenLevelMerge;
```

- [ ] **Step 4: Relancer les tests pour vérifier qu'ils passent**

Run: `cd packages/core && pnpm vitest run src/__tests__/patterns/token-level-merge.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/patterns/token-level-merge.ts packages/core/src/__tests__/patterns/token-level-merge.test.ts
git commit -m "feat(core): implement token_level_merge pattern (line + token-level decomposition)"
```

---

### Task 3: Enregistrer le pattern dans le classifier + exposer la trace

**Files:**
- Modify: `packages/core/src/classifier.ts:15-46` (import + registre `PATTERNS`)
- Modify: `packages/core/src/classifier.ts:97-116` (`buildSummary`)
- Modify: `packages/core/src/classifier.ts:129-158` (`classifyConflict` — attacher `tokenMergeTrace`)
- Test: `packages/core/src/__tests__/patterns/token-level-merge.test.ts` (ajout de cas via
  `classifyConflict`)

**Interfaces:**
- Consumes: `tokenLevelMerge` (default export, Task 2), `getLastTokenMergeResult()` (Task 2).
- Produces: `classifyConflict(hunk)` retourne désormais `type: "token_level_merge"` avec
  `trace.tokenMergeTrace` renseigné pour les hunks concernés.

- [ ] **Step 1: Écrire le test d'intégration classifier**

Ajouter à la fin de `packages/core/src/__tests__/patterns/token-level-merge.test.ts` :

```typescript
import { classifyConflict } from "../../classifier.js";

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

  it("le cas de régression réel (upsells/suggestions) classifie en token_level_merge", () => {
    const h = input(
      ['<div class="flex items-baseline gap-x-2 mr-2">', '<label class="font-weight-bold">'],
      ['<div class="flex items-baseline gap-x-2 mr-2">', '<label class="font-bold">'],
      ['<div class="flex items-baseline space-x-2 mr-2">', '<label class="font-weight-bold">'],
    );
    const result = classifyConflict(h);
    expect(result.type).toBe("token_level_merge");
    expect(result.trace.tokenMergeTrace?.pass1Count).toBe(2);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `cd packages/core && pnpm vitest run src/__tests__/patterns/token-level-merge.test.ts`
Expected: FAIL — `result.type` vaut `"complex"` (pattern pas encore enregistré).

- [ ] **Step 3: Enregistrer le pattern dans `classifier.ts`**

Modifier les imports (ligne ~15-25) :

```typescript
import sameChange          from "./patterns/same-change.js";
import deleteNoChange      from "./patterns/delete-no-change.js";
import oneSideChange       from "./patterns/one-side-change.js";
import nonOverlapping      from "./patterns/non-overlapping.js";
import whitespaceOnly      from "./patterns/whitespace-only.js";
import reorderOnly              from "./patterns/reorder-only.js";
import insertionAtBoundary      from "./patterns/insertion-at-boundary.js";
import valueOnlyChange          from "./patterns/value-only-change.js";
import tokenLevelMerge          from "./patterns/token-level-merge.js";     // v2.7 — priority 65
import llmProposed         from "./patterns/llm-proposed.js";    // v2.5 — priority 998
import refactoringAwareMerge from "./patterns/refactoring-aware-merge.js"; // v2.6 — priority 970
import complex             from "./patterns/complex.js";
import { getLastTokenMergeResult } from "./patterns/token-level-merge.js";
```

Modifier le registre `PATTERNS` (ligne ~34-46) :

```typescript
const PATTERNS: PatternPlugin[] = [
  sameChange,           // priority 10
  deleteNoChange,       // priority 20
  oneSideChange,        // priority 30
  nonOverlapping,       // priority 40
  whitespaceOnly,       // priority 50
  reorderOnly,          // priority 55  ← v1.4
  insertionAtBoundary,  // priority 57  ← v1.4
  valueOnlyChange,        // priority 60
  tokenLevelMerge,        // priority 65 ← v2.7 (jamais auto-appliqué, cf. assemble.ts)
  refactoringAwareMerge, // priority 970 ← v2.6 (OFF par défaut, activé par resolve())
  llmProposed,            // priority 998 ← v2.5 (OFF par défaut, activé par resolveAsync)
  complex,               // priority 999 (fallback — detect() always true)
];
```

Modifier `buildSummary()` (ligne ~97-116) pour ajouter un cas :

```typescript
    case "value_only_change":    return "Même structure, valeur(s) volatile(s) différente(s) — résolution : accepter theirs.";
    case "token_level_merge":    return "Fusion ligne/token proposée — confirmation utilisateur requise avant application.";
    case "llm_proposed":         return "LLM fallback activé — résolution déléguée à l'endpoint LLM configuré.";
```

Modifier `classifyConflict()` (ligne ~144-153) pour attacher `tokenMergeTrace` :

```typescript
  for (const pattern of eligible) {
    if (pattern.detect(hunk)) {
      const trace = buildTrace(hunk, eligible, allSorted, pattern);
      if (pattern.type === "token_level_merge") {
        trace.tokenMergeTrace = getLastTokenMergeResult() ?? undefined;
      }
      return {
        type: pattern.type,
        confidence: pattern.confidence(hunk),
        explanation: pattern.explanation(hunk),
        trace,
      };
    }
  }
```

- [ ] **Step 4: Relancer les tests pour vérifier qu'ils passent**

Run: `cd packages/core && pnpm vitest run src/__tests__/patterns/token-level-merge.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Lancer la suite complète de `packages/core` pour vérifier l'absence de régression**

Run: `cd packages/core && pnpm test`
Expected: PASS — en particulier, vérifier qu'aucun hunk auparavant classé `complex` dans
`__tests__/corpus.ts` ne change silencieusement de classification de façon inattendue (si un
test du corpus échoue ici, inspecter s'il correspond en réalité à un cas token_level_merge
légitime — l'ajuster plutôt que le contourner).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/classifier.ts packages/core/src/__tests__/patterns/token-level-merge.test.ts
git commit -m "feat(core): register token_level_merge in classifier, attach proposal trace"
```

---

### Task 4: `resolver/assemble.ts` — ne jamais auto-appliquer

**Files:**
- Modify: `packages/core/src/resolver/assemble.ts:146` (ajout d'un `case` avant `"generated_file"`)
- Test: `packages/core/src/__tests__/resolver.test.ts` (ajout de cas — vérifier le fichier
  existant pour respecter le style avant d'ajouter)

**Interfaces:**
- Consumes: `hunk.type === "token_level_merge"` (Task 3).
- Produces: `assembleResolution()` retourne `{ lines: null, reason: "..." }` pour ce type — le
  hunk reste non auto-résolu (`HunkResolution.autoResolved === false`) au niveau du core, exactement
  comme `complex`, mais avec `type: "token_level_merge"` pour que le frontend affiche la
  proposition plutôt que le seul fallback manuel.

- [ ] **Step 1: Lire le test existant pour connaître le pattern d'assertion**

Run: `grep -n "llm_proposed\|describe(\"assembleResolution" packages/core/src/__tests__/resolver.test.ts`

Utiliser la structure trouvée (probablement `resolve(input, filePath)` puis assertions sur
`result.hunks[0].type` et `result.stats.remaining`) pour écrire le nouveau cas ci-dessous dans
le même style.

- [ ] **Step 2: Écrire le test**

Ajouter dans `packages/core/src/__tests__/resolver.test.ts` :

```typescript
describe("assembleResolution : token_level_merge n'est jamais auto-appliqué", () => {
  it("un hunk token_level_merge reste non-résolu (autoResolved: false)", () => {
    const conflict = [
      "<<<<<<< ours",
      '<div class="a2 b">',
      "|||||||",
      '<div class="a b">',
      "=======",
      '<div class="a b2">',
      ">>>>>>> theirs",
    ].join("\n");
    const result = resolve(conflict, "src/test.html");
    expect(result.hunks[0].type).toBe("token_level_merge");
    expect(result.resolutions[0].autoResolved).toBe(false);
    expect(result.resolutions[0].resolvedLines).toBeNull();
    expect(result.stats.remaining).toBe(1);
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue**

Run: `cd packages/core && pnpm vitest run src/__tests__/resolver.test.ts -t "token_level_merge n'est jamais auto-appliqué"`
Expected: FAIL — soit le `type` n'est pas `token_level_merge` (peu probable après Task 3), soit
`assembleResolution` tombe dans `default` avec une `reason` différente (le test sur `reason` n'est
pas fait ici, donc le test devrait déjà passer partiellement — mais on l'écrit quand même en TDD
pour verrouiller le contrat avant d'ajouter le `case` explicite).

- [ ] **Step 4: Ajouter le `case` explicite dans `assemble.ts`**

Dans `packages/core/src/resolver/assemble.ts`, juste avant le `case "generated_file":` (ligne
~161), ajouter :

```typescript
    case "token_level_merge":
      // v2.7 — Résolution toujours différée à la confirmation utilisateur (frontend).
      // La proposition calculée est disponible dans hunk.trace.tokenMergeTrace.
      return {
        lines: null,
        reason: "token_level_merge : fusion proposée, confirmation utilisateur requise avant application.",
      };
```

- [ ] **Step 5: Relancer le test pour vérifier qu'il passe**

Run: `cd packages/core && pnpm vitest run src/__tests__/resolver.test.ts -t "token_level_merge n'est jamais auto-appliqué"`
Expected: PASS.

- [ ] **Step 6: Lancer la suite complète**

Run: `cd packages/core && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/resolver/assemble.ts packages/core/src/__tests__/resolver.test.ts
git commit -m "feat(core): token_level_merge never auto-applies in assembleResolution"
```

---

### Task 5: Ajouter le cas de régression réel au corpus

**Files:**
- Modify: `packages/core/src/__tests__/corpus.ts` (nouvelle section)

**Interfaces:**
- Consumes: rien de nouveau — utilise `resolve()` comme les autres entrées du corpus.

- [ ] **Step 1: Lire la structure d'une entrée existante du corpus**

Run: `grep -n "describe(\"" packages/core/src/__tests__/corpus.ts | tail -5`

Repérer le style (probablement : commentaire décrivant la provenance réelle, `describe()` +
contenu conflict brut + assertions sur `type` et `stats`).

- [ ] **Step 2: Ajouter l'entrée de régression**

À la fin de `packages/core/src/__tests__/corpus.ts`, ajouter (adapter l'exact style trouvé à
l'étape 1 si le fichier utilise un helper commun plutôt que `resolve()` direct) :

```typescript
// ─── Régression — upsells/suggestions/index.blade.php (2026-07-06) ──────
// Deux lignes adjacentes, chacune modifiée par un seul côté (classes Tailwind/
// utilitaires) : gap-x-2→space-x-2 sur une ligne, font-weight-bold→font-bold
// sur l'autre. Classé "complex" avant l'introduction de token_level_merge —
// ce test verrouille la régression.
describe("corpus : upsells/suggestions/index.blade.php — deux lignes adjacentes, un seul côté par ligne", () => {
  const conflict = [
    "<<<<<<< ours",
    '            <div class="flex items-baseline gap-x-2 mr-2">',
    '                <label for="filters[\'status\']" class="font-weight-bold">',
    "|||||||",
    '            <div class="flex items-baseline gap-x-2 mr-2">',
    '                <label for="filters[\'status\']" class="font-weight-bold">',
    "=======",
    '            <div class="flex items-baseline space-x-2 mr-2">',
    '                <label for="filters[\'status\']" class="font-weight-bold">',
    ">>>>>>> theirs",
  ].join("\n");

  it("classifie en token_level_merge (plus 'complex')", () => {
    const result = resolve(conflict, "resources/views/gestion/upsells/suggestions/index.blade.php");
    expect(result.hunks[0].type).toBe("token_level_merge");
  });

  it("la proposition calculée porte les deux lignes attendues", () => {
    const result = resolve(conflict, "resources/views/gestion/upsells/suggestions/index.blade.php");
    expect(result.hunks[0].trace.tokenMergeTrace?.mergedLines).toEqual([
      '            <div class="flex items-baseline space-x-2 mr-2">',
      '                <label for="filters[\'status\']" class="font-weight-bold">',
    ]);
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il passe**

Run: `cd packages/core && pnpm vitest run src/__tests__/corpus.ts -t "upsells/suggestions"`
Expected: PASS (2 tests).

> Remarque : si le test échoue parce que la 2ème ligne (`label`, identique des deux côtés dans
> cet extrait réduit) n'était pas un vrai conflit dans le fichier réel, ajuster l'exemple pour
> refléter fidèlement le contenu observé dans les captures d'écran d'origine (la ligne 16
> montrait `font-weight-bold` côté ours vs `font-bold` côté theirs dans le screenshot complet —
> adapter les 3 sections `ours`/`base`/`theirs` en conséquence avant de committer).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/corpus.ts
git commit -m "test(core): add real-world regression case for token_level_merge"
```

---

### Task 6: Nouveau composant `TokenMergePanel.vue`

**Files:**
- Create: `apps/desktop/src/components/TokenMergePanel.vue`
- Test: `apps/desktop/src/components/__tests__/TokenMergePanel.test.ts`

**Interfaces:**
- Consumes: `TokenMergeTrace` (type importé depuis `@gitwand/core`), `useI18n()` (`t()`).
- Produces: composant avec `props: { trace: TokenMergeTrace; hunkId: number; accepted?: boolean }`
  et `emits: { accept: [hunkId: number]; reject: [hunkId: number] }` — même contrat que
  `LlmTracePanel.vue` pour rester cohérent visuellement, mais fichier séparé (pas de refactor de
  `LlmTracePanel` — celui-ci reste couplé à `LlmTrace`, YAGNI : pas de généralisation
  prématurée d'un composant qui fonctionne).

**Convention de test vérifiée** : ce projet n'utilise **pas** `@vue/test-utils` pour ces
composants — voir `apps/desktop/src/components/__tests__/LlmTracePanel.test.ts`, qui monte via
`createApp(Component, props)` natif dans un container jsdom, interagit via `querySelector` +
`.click()` DOM natif, et écoute les émissions via la prop `onXxx` (convention Vue). On reproduit
exactement ce style.

- [ ] **Step 1: Écrire le test du composant**

```typescript
// apps/desktop/src/components/__tests__/TokenMergePanel.test.ts
/**
 * TokenMergePanel.vue — accept/reject action UI for proposed token-level merges.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep) and a
 * real `useI18n` (default locale → English keys), mirroring LlmTracePanel.test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, nextTick, type App } from "vue";
import TokenMergePanel from "../TokenMergePanel.vue";
import type { TokenMergeTrace } from "@gitwand/core";

const trace: TokenMergeTrace = {
  mergedLines: ['<div class="a2 b2">'],
  pass1Count: 0,
  pass2Count: 1,
  lineDetails: [
    { lineIndex: 0, resolvedBy: "pass2", resolvedLine: '<div class="a2 b2">', oursTokenIndices: [2], theirsTokenIndices: [4] },
  ],
};

let app: App | null = null;
let container: HTMLElement;

function mount(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(TokenMergePanel, {
    trace,
    hunkId: 3,
    ...props,
  });
  app.mount(container);
}

beforeEach(() => {
  localStorage.clear(); // ensure default (English) locale
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

describe("TokenMergePanel actions", () => {
  it("shows the Accept button (not the badge) when not accepted", () => {
    mount({ accepted: false });
    expect(container.querySelector(".token-merge-panel__btn--accept")).not.toBeNull();
    expect(container.querySelector(".token-merge-panel__accepted-badge")).toBeNull();
  });

  it("displays the pass1/pass2 line counts", () => {
    mount({ accepted: false });
    expect(container.textContent).toContain("1"); // pass2Count: 1
  });

  it("swaps the Accept/Reject buttons for a badge when accepted", () => {
    mount({ accepted: true });
    expect(container.querySelector(".token-merge-panel__accepted-badge")).not.toBeNull();
    expect(container.querySelector(".token-merge-panel__btn--accept")).toBeNull();
    expect(container.querySelector(".token-merge-panel__btn--reject")).toBeNull();
  });

  it("emits `accept` with the hunk id when Accept is clicked", async () => {
    const onAccept = vi.fn();
    mount({ accepted: false, onAccept });
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--accept")!
      .click();
    await nextTick();
    expect(onAccept).toHaveBeenCalledWith(3);
  });

  it("emits `reject` with the hunk id when Reject is clicked", async () => {
    const onReject = vi.fn();
    mount({ accepted: false, onReject });
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--reject")!
      .click();
    await nextTick();
    expect(onReject).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/TokenMergePanel.test.ts`
Expected: FAIL — `Cannot find module '../TokenMergePanel.vue'`.

- [ ] **Step 3: Implémenter le composant**

```vue
<!-- apps/desktop/src/components/TokenMergePanel.vue -->
<script setup lang="ts">
import type { TokenMergeTrace } from "@gitwand/core";
import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
  trace: TokenMergeTrace;
  hunkId: number;
  accepted?: boolean;
}>();

const emit = defineEmits<{
  accept: [hunkId: number];
  reject: [hunkId: number];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="token-merge-panel">
    <div class="token-merge-panel__header">
      <span class="token-merge-panel__title">{{ t('mergeEditor.tokenLevelMerge.title') }}</span>
    </div>
    <p class="token-merge-panel__summary">
      {{ t('mergeEditor.tokenLevelMerge.pass1Lines', props.trace.pass1Count) }}
      {{ t('mergeEditor.tokenLevelMerge.pass2Lines', props.trace.pass2Count) }}
    </p>
    <pre class="token-merge-panel__preview">{{ props.trace.mergedLines.join('\n') }}</pre>
    <div class="token-merge-panel__actions">
      <template v-if="!props.accepted">
        <button
          type="button"
          class="token-merge-panel__btn token-merge-panel__btn--accept"
          @click="emit('accept', props.hunkId)"
        >
          {{ t('mergeEditor.tokenLevelMerge.accept') }}
        </button>
        <button
          type="button"
          class="token-merge-panel__btn token-merge-panel__btn--reject"
          @click="emit('reject', props.hunkId)"
        >
          {{ t('mergeEditor.tokenLevelMerge.reject') }}
        </button>
      </template>
      <span v-else class="token-merge-panel__accepted-badge">
        {{ t('mergeEditor.tokenLevelMerge.accepted') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.token-merge-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  margin: 8px 0;
  background: var(--color-bg-secondary);
}
.token-merge-panel__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.token-merge-panel__title {
  font-weight: 600;
  font-size: 13px;
}
.token-merge-panel__summary {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0 0 8px 0;
}
.token-merge-panel__preview {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-bg-primary);
  border-radius: var(--radius-sm);
  padding: 8px;
  overflow-x: auto;
  margin: 0 0 8px 0;
}
.token-merge-panel__actions {
  display: flex;
  gap: 8px;
}
.token-merge-panel__btn {
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--color-border);
}
.token-merge-panel__btn--accept {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.token-merge-panel__btn--reject {
  background: transparent;
}
.token-merge-panel__accepted-badge {
  font-size: 12px;
  color: var(--color-success);
}
</style>
```

Note : `t('mergeEditor.tokenLevelMerge.pass1Lines', props.trace.pass1Count)` suppose une clé
i18n avec interpolation positionnelle `{0}` (ajoutée au Task 8) — vérifier le rendu exact après
le Task 8, ajuster le texte du template si le libellé combiné passe1+passe2 doit être une seule
phrase plutôt que deux clés concaténées (décision UX libre à ce stade, pas bloquante pour les
tests).

- [ ] **Step 4: Relancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/TokenMergePanel.test.ts`
Expected: PASS (4 tests). Si le test échoue à cause des clés i18n manquantes (texte vide au lieu
du libellé attendu), ajouter d'abord les clés `en` minimales requises par le test (voir Task 8)
avant de relancer — l'ordre Task 6 → Task 8 peut être inversé si plus pratique, aucune
dépendance dure entre les deux hormis cette clé.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/TokenMergePanel.vue apps/desktop/src/components/__tests__/TokenMergePanel.test.ts
git commit -m "feat(desktop): add TokenMergePanel component for proposed resolutions"
```

---

### Task 7: Câbler `TokenMergePanel` dans `MergeEditor.vue`

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue`
  - Imports (haut de fichier)
  - Emits (ligne ~37-48) — aucun changement, `resolveHunkCustom` existe déjà
  - État réactif (près de `acceptedLlmHunks`, ligne ~334)
  - Handlers (près de `onLlmAccept`/`onLlmReject`, ligne ~343-362)
  - Template (près du `<LlmTracePanel>`, ligne ~793-801)
  - Minimap (ligne ~1091, ajout d'une couleur)
- Test: `apps/desktop/src/components/__tests__/MergeEditor.test.ts` (vérifier le fichier existant
  pour le style d'assertion — lire avant d'écrire)

**Interfaces:**
- Consumes: `TokenMergePanel` (Task 6), `hunk.type === "token_level_merge"`,
  `hunk.trace.tokenMergeTrace` (Task 3), emit existant `resolveHunkCustom(path, hunkIndex,
  content: string)`.
- Produces: quand l'utilisateur clique "Accepter", `MergeEditor` émet
  `resolveHunkCustom(file.path, hunkIndex, trace.mergedLines.join("\n"))` — exactement le même
  chemin que l'édition manuelle (`validateEditing()`) ou l'acceptation d'une suggestion IA. Le
  hunk redevient un 3-way manuel classique si l'utilisateur rejette.

**Convention de test vérifiée** : `apps/desktop/src/components/__tests__/MergeEditor.test.ts`
existant n'utilise ni `@vue/test-utils` ni de helper `buildHunk`/`buildConflictFile` — il monte
via `createApp` + `h()` natif (voir `mountWithFile()`, ligne 87-99) dans un `reactive` wrapper,
et construit `ConflictFile` à la main avec un cast `as unknown as ConflictFile["result"]` pour
les champs non essentiels au test. Le composant lit les segments à partir de
`props.file.content` (texte brut avec marqueurs `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`, voir
`segments` computed, ligne 379) et associe chaque bloc de conflit au `ConflictHunk`
correspondant dans `props.file.result.hunks[hunkIndex]` (même ordre). Il faut donc fournir les
deux en cohérence.

- [ ] **Step 1: Écrire le test d'intégration**

Ajouter dans `apps/desktop/src/components/__tests__/MergeEditor.test.ts`, en réutilisant le
pattern `mountWithFile`/`FakeResizeObserver` déjà présent dans le fichier :

```typescript
import type { ConflictHunk } from "@gitwand/core";

function tokenMergeHunk(): ConflictHunk {
  return {
    baseLines: ['<div class="a b">'],
    oursLines: ['<div class="a2 b">'],
    theirsLines: ['<div class="a b2">'],
    startLine: 2,
    type: "token_level_merge",
    confidence: {
      score: 62,
      label: "medium",
      dimensions: { typeClassification: 70, dataRisk: 38, scopeImpact: 0, fileFrequency: 0, baseAvailability: 0 },
      boosters: [],
      penalties: [],
    },
    explanation: "Fusion proposée : 0 ligne résolue ligne par ligne, 1 ligne fusionnée token par token.",
    trace: {
      steps: [],
      selected: "token_level_merge",
      summary: "test",
      hasBase: true,
      tokenMergeTrace: {
        mergedLines: ['<div class="a2 b2">'],
        pass1Count: 0,
        pass2Count: 1,
        lineDetails: [{ lineIndex: 0, resolvedBy: "pass2", resolvedLine: '<div class="a2 b2">' }],
      },
    },
  };
}

function tokenMergeFile(): ConflictFile {
  const content = [
    "line before",
    "<<<<<<< ours",
    '<div class="a2 b">',
    "|||||||",
    '<div class="a b">',
    "=======",
    '<div class="a b2">',
    ">>>>>>> theirs",
    "line after",
  ].join("\n");
  return {
    path: "src/foo.html",
    content,
    result: {
      filePath: "src/foo.html",
      mergedContent: null,
      hunks: [tokenMergeHunk()],
      resolutions: [{ hunk: tokenMergeHunk(), resolvedLines: null, autoResolved: false, resolutionReason: "test" }],
      stats: { totalConflicts: 1, autoResolved: 0 },
      validation: { valid: true, errors: [] },
    } as unknown as ConflictFile["result"],
  };
}

/** Direct mount (bypasses mountWithFile's reactive wrapper) so `onXxx` emit listeners can be passed. */
function mountDirect(file: ConflictFile, extraProps: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(MergeEditor, { file, ...extraProps });
  app.mount(container);
}

describe("MergeEditor : panneau token_level_merge", () => {
  it("affiche TokenMergePanel pour un hunk token_level_merge", () => {
    mountDirect(tokenMergeFile());
    expect(container.querySelector(".token-merge-panel")).not.toBeNull();
  });

  it("émet resolveHunkCustom avec les mergedLines au clic sur Accepter", async () => {
    let emitted: unknown[] | null = null;
    mountDirect(tokenMergeFile(), {
      onResolveHunkCustom: (...args: unknown[]) => { emitted = args; },
    });
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--accept")!
      .click();
    await nextTick();
    expect(emitted).toEqual(["src/foo.html", 0, '<div class="a2 b2">']);
  });

  it("rejeter masque le panneau et bascule vers l'affichage manuel", async () => {
    mountDirect(tokenMergeFile());
    container
      .querySelector<HTMLButtonElement>(".token-merge-panel__btn--reject")!
      .click();
    await nextTick();
    expect(container.querySelector(".token-merge-panel")).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "token_level_merge"`
Expected: FAIL — `TokenMergePanel` non rendu (condition `v-if` absente, import manquant).

- [ ] **Step 3: Ajouter l'import**

En haut de `MergeEditor.vue`, à côté de l'import de `LlmTracePanel` :

```typescript
import TokenMergePanel from "./TokenMergePanel.vue";
```

- [ ] **Step 4: Ajouter l'état réactif et les handlers**

À côté de `acceptedLlmHunks`/`rejectedLlmHunks` (ligne ~334) :

```typescript
const rejectedTokenMergeHunks = ref<Set<number>>(new Set());
```

À côté de `onLlmAccept`/`onLlmReject` (ligne ~343-362) :

```typescript
function onTokenMergeAccept(hunkIndex: number) {
  const hunk = hunks.value[hunkIndex];
  const proposal = hunk?.trace.tokenMergeTrace;
  if (!proposal) return;
  emit("resolveHunkCustom", props.file.path, hunkIndex, proposal.mergedLines.join("\n"));
}

function onTokenMergeReject(hunkIndex: number) {
  const next = new Set(rejectedTokenMergeHunks.value);
  next.add(hunkIndex);
  rejectedTokenMergeHunks.value = next;
}

function showTokenMergePanelFor(hunkIndex: number, hunk: ConflictHunk): boolean {
  if (hunk.type !== "token_level_merge") return false;
  if (!hunk.trace.tokenMergeTrace) return false;
  return !rejectedTokenMergeHunks.value.has(hunkIndex);
}
```

- [ ] **Step 5: Ajouter le rendu conditionnel dans le template**

Juste après le `<LlmTracePanel ... />` existant (ligne ~793-801), ajouter :

```vue
<TokenMergePanel
  v-if="hunkForSegment(seg) && seg.hunkIndex != null && showTokenMergePanelFor(seg.hunkIndex, hunkForSegment(seg)!)"
  :trace="hunkForSegment(seg)!.trace.tokenMergeTrace!"
  :hunk-id="seg.hunkIndex"
  @accept="onTokenMergeAccept"
  @reject="onTokenMergeReject"
/>
```

- [ ] **Step 6: Étendre `isAutoResolvable` pour exclure ce type de la couleur "vert" existante**

Vérifier la fonction (ligne ~454) :

```typescript
function isAutoResolvable(hunk: ConflictHunk): boolean {
  return hunk.type !== "complex" && hunk.confidence.label !== "high";
}
```

`token_level_merge` a `confidence.label === "medium"` (Task 2), donc `isAutoResolvable`
renverrait `true` avec l'implémentation actuelle — ce qui appliquerait la classe CSS verte
`.conflict-hunk--resolvable` alors que le hunk n'est PAS auto-résolu. Corriger :

```typescript
function isAutoResolvable(hunk: ConflictHunk): boolean {
  return hunk.type !== "complex" && hunk.type !== "token_level_merge" && hunk.confidence.label !== "high";
}
```

- [ ] **Step 7: Ajouter la couleur minimap dédiée**

Repérer la fonction qui calcule la couleur par segment pour la minimap (recherche `merge-minimap`
et la fonction qui lui fournit ses couleurs — probablement un `computed` proche de la déclaration
canvas, ligne ~1091). Ajouter un cas pour `token_level_merge` retournant une couleur ambre (ex.
`#d97706` ou la variable `--color-warning` si elle existe déjà dans le design system — vérifier
`apps/desktop/src/assets/` avant d'introduire une nouvelle couleur en dur).

- [ ] **Step 8: Relancer les tests pour vérifier qu'ils passent**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts -t "token_level_merge"`
Expected: PASS (3 tests).

- [ ] **Step 9: Lancer la suite complète du composant pour vérifier l'absence de régression**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/MergeEditor.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue apps/desktop/src/components/__tests__/MergeEditor.test.ts
git commit -m "feat(desktop): wire TokenMergePanel into MergeEditor, apply via resolveHunkCustom"
```

---

### Task 8: i18n — clés dans les 5 locales

**Files:**
- Modify: `apps/desktop/src/locales/en.ts:1719` (après `llmResolution`)
- Modify: `apps/desktop/src/locales/fr.ts:1696`
- Modify: `apps/desktop/src/locales/es.ts:1686`
- Modify: `apps/desktop/src/locales/pt-br.ts:1686`
- Modify: `apps/desktop/src/locales/zh-cn.ts:1671`
- Test: `apps/desktop/src/composables/__tests__/useI18n.test.ts` (si un test générique "toutes
  les clés existent dans toutes les locales" existe déjà — vérifier avant d'écrire un nouveau
  test)

**Interfaces:**
- Produces: clé `mergeEditor.tokenLevelMerge.{title,pass1Lines,pass2Lines,accept,reject,accepted}`
  dans les 5 fichiers de locale, structure identique à `llmResolution`.

- [ ] **Step 1: Vérifier s'il existe déjà un test de complétude i18n**

Run: `grep -rln "toutes les clés\|missing.*locale\|localeKeys" apps/desktop/src/composables/__tests__/ apps/desktop/src/locales/`

- Si un tel test existe : passer directement à Step 3 (l'ajout des clés le fera passer/échouer
  naturellement selon l'ordre).
- Si aucun test de ce type n'existe : écrire le test suivant.

- [ ] **Step 2: Écrire le test de complétude (si absent)**

```typescript
// apps/desktop/src/locales/__tests__/token-level-merge-i18n.test.ts
import { describe, it, expect } from "vitest";
import en from "../en.js";
import fr from "../fr.js";
import es from "../es.js";
import ptBr from "../pt-br.js";
import zhCn from "../zh-cn.js";

const LOCALES = { en, fr, es, "pt-br": ptBr, "zh-cn": zhCn };
const REQUIRED_KEYS = ["title", "pass1Lines", "pass2Lines", "accept", "reject", "accepted"];

describe("i18n : mergeEditor.tokenLevelMerge présent dans les 5 locales", () => {
  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`${name} a toutes les clés requises`, () => {
      const section = (locale as any).mergeEditor?.tokenLevelMerge;
      expect(section).toBeDefined();
      for (const key of REQUIRED_KEYS) {
        expect(section[key], `clé manquante: ${key} (${name})`).toBeTypeOf("string");
      }
    });
  }
});
```

(Adapter le chemin d'import et la forme d'export exacte des fichiers de locale — vérifier via
`tail -5 apps/desktop/src/locales/en.ts` si l'export est `export default {...}` ou un export
nommé, avant d'écrire l'import ci-dessus.)

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue**

Run: `cd apps/desktop && pnpm vitest run src/locales/__tests__/token-level-merge-i18n.test.ts`
Expected: FAIL — `section` est `undefined` pour les 5 locales.

- [ ] **Step 4: Ajouter les clés dans `fr.ts` (référence)**

Après le bloc `llmResolution` (ligne ~1696-1702) :

```typescript
    llmResolution: {
      title: "Résolu par LLM (expérimental)",
      reject: "Rejeter → résolution manuelle",
      accept: "Accepter",
      accepted: "Accepté",
      details: "Détails de la trace",
    },
    tokenLevelMerge: {
      title: "Fusion fine proposée (ligne + token)",
      pass1Lines: "{0} ligne(s) résolue(s) ligne par ligne.",
      pass2Lines: "{0} ligne(s) fusionnée(s) token par token.",
      accept: "Accepter",
      reject: "Rejeter → résolution manuelle",
      accepted: "Accepté",
    },
```

- [ ] **Step 5: Ajouter les clés dans `en.ts`**

Après le bloc `llmResolution` (ligne ~1719-1725) :

```typescript
    llmResolution: {
      title: "Resolved by LLM (experimental)",
      reject: "Reject → resolve manually",
      accept: "Accept",
      accepted: "Accepted",
      details: "Trace details",
    },
    tokenLevelMerge: {
      title: "Fine-grained merge proposed (line + token)",
      pass1Lines: "{0} line(s) resolved line-by-line.",
      pass2Lines: "{0} line(s) merged token-by-token.",
      accept: "Accept",
      reject: "Reject → resolve manually",
      accepted: "Accepted",
    },
```

- [ ] **Step 6: Ajouter les clés dans `es.ts`**

Après le bloc `llmResolution` (ligne ~1686-1692) :

```typescript
    llmResolution: {
      title: "Resuelto por LLM (experimental)",
      reject: "Rechazar → resolver manualmente",
      accept: "Aceptar",
      accepted: "Aceptado",
      details: "Detalles de la traza",
    },
    tokenLevelMerge: {
      title: "Fusión fina propuesta (línea + token)",
      pass1Lines: "{0} línea(s) resuelta(s) línea por línea.",
      pass2Lines: "{0} línea(s) fusionada(s) token por token.",
      accept: "Aceptar",
      reject: "Rechazar → resolver manualmente",
      accepted: "Aceptado",
    },
```

- [ ] **Step 7: Ajouter les clés dans `pt-br.ts`**

Après le bloc `llmResolution` (ligne ~1686-1692) :

```typescript
    llmResolution: {
      title: "Resolvido por LLM (experimental)",
      reject: "Rejeitar → resolver manualmente",
      accept: "Aceitar",
      accepted: "Aceito",
      details: "Detalhes do rastro",
    },
    tokenLevelMerge: {
      title: "Fusão fina proposta (linha + token)",
      pass1Lines: "{0} linha(s) resolvida(s) linha a linha.",
      pass2Lines: "{0} linha(s) mesclada(s) token a token.",
      accept: "Aceitar",
      reject: "Rejeitar → resolver manualmente",
      accepted: "Aceito",
    },
```

- [ ] **Step 8: Ajouter les clés dans `zh-cn.ts`**

Après le bloc `llmResolution` (ligne ~1671-1677) :

```typescript
    llmResolution: {
      title: "由 LLM 解决（实验性）",
      reject: "拒绝 → 手动解决",
      accept: "接受",
      accepted: "已接受",
      details: "追踪详情",
    },
    tokenLevelMerge: {
      title: "提议的精细合并（行 + 词法单元）",
      pass1Lines: "{0} 行已逐行解决。",
      pass2Lines: "{0} 行已逐词法单元合并。",
      accept: "接受",
      reject: "拒绝 → 手动解决",
      accepted: "已接受",
    },
```

- [ ] **Step 9: Relancer le test de complétude**

Run: `cd apps/desktop && pnpm vitest run src/locales/__tests__/token-level-merge-i18n.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Relancer les tests de `TokenMergePanel.test.ts` (Task 6) et `MergeEditor.test.ts` (Task 7)**

Run: `cd apps/desktop && pnpm vitest run src/components/__tests__/TokenMergePanel.test.ts src/components/__tests__/MergeEditor.test.ts`
Expected: PASS — les libellés i18n sont désormais résolus correctement dans les assertions de
texte.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-br.ts apps/desktop/src/locales/zh-cn.ts apps/desktop/src/locales/__tests__/token-level-merge-i18n.test.ts
git commit -m "i18n(desktop): add tokenLevelMerge keys to all 5 locales"
```

---

### Task 9: Vérification manuelle de bout en bout

**Files:** aucun changement de code — vérification uniquement.

- [ ] **Step 1: Lancer la suite complète `packages/core`**

Run: `cd packages/core && pnpm test`
Expected: PASS, aucune régression sur les patterns existants.

- [ ] **Step 2: Lancer le bench de performance (règle `packages/core/CLAUDE.md`)**

Run: `cd packages/core && pnpm bench`
Expected: pas de régression significative — le nouveau pattern n'est évalué qu'après l'échec de
tous les patterns 10-60, sur un sous-ensemble déjà restreint de hunks (pas de coût ajouté sur le
chemin heureux des conflits triviaux).

- [ ] **Step 3: Lancer la suite complète `apps/desktop`**

Run: `cd apps/desktop && pnpm test`
Expected: PASS.

- [ ] **Step 4: Vérification manuelle via `pnpm dev:web`**

Run: `cd apps/desktop && pnpm dev:web`

Ouvrir l'app, créer (ou utiliser une fixture existante) un repo avec un conflit reproduisant le
cas réel : deux lignes adjacentes où chaque ligne n'a qu'un côté qui diverge de la base. Vérifier
visuellement :
- Le panneau `TokenMergePanel` s'affiche avec le nombre de lignes passe 1/passe 2 correct.
- Le bouton "Accepter" applique bien le contenu fusionné (le hunk disparaît de la liste des
  conflits restants, le contenu du fichier reflète la fusion).
- Le bouton "Rejeter" masque le panneau et bascule vers l'affichage manuel 3 colonnes standard.
- La minimap affiche la couleur ambre dédiée pour ce hunk avant résolution.

- [ ] **Step 5: Documenter le pattern dans `packages/core/CLAUDE.md`**

Ajouter une ligne au tableau "Hiérarchie des patterns" (section `packages/core/CLAUDE.md`) :

```markdown
| 65 | `token_level_merge` | 0.7 (jamais auto-appliqué) | Décomposition ligne/token réussie — proposition soumise à confirmation utilisateur |
```

Ajouter une note sous le tableau signalant que ce pattern est la seule exception à la règle
"confidence pilote l'auto-application" — toujours proposé, jamais appliqué automatiquement,
quel que soit le score.

- [ ] **Step 6: Commit de la documentation**

```bash
git add packages/core/CLAUDE.md
git commit -m "docs(core): document token_level_merge in pattern hierarchy table"
```

---

## Hors périmètre de ce plan (signalé, pas traité)

- `apps/desktop/CLAUDE.md` contient une description obsolète du "parity probe" affirmant qu'il
  reproduit la logique de résolution de conflits en Rust — faux d'après le code actuel (voir
  Global Constraints). Correction de cette documentation à traiter séparément, hors scope de ce
  plan.
