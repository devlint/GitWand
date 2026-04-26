/**
 * Tests de `detectBlockMove` (v2.1).
 */

import { describe, it, expect } from "vitest";
import { detectBlockMove } from "../../diff/block-move.js";

describe("detectBlockMove — cas trivial", () => {
  it("aucun déplacement → []", () => {
    const base = ["a", "b", "c", "d", "e", "f", "g"];
    const ours = ["a", "b", "c", "d", "e", "f", "g"];
    const theirs = ["a", "b", "c", "d", "e", "f", "g"];
    expect(detectBlockMove(base, ours, theirs)).toEqual([]);
  });

  it("entrées trop courtes (< windowSize) → []", () => {
    const base = ["a", "b"];
    const ours = ["a", "b"];
    const theirs = ["a", "b"];
    expect(detectBlockMove(base, ours, theirs)).toEqual([]);
  });
});

describe("detectBlockMove — bloc déplacé identique des deux côtés", () => {
  it("détecte un bloc unique inséré dans ours et theirs aux mêmes lignes", () => {
    const base = [
      `import { a } from "./a";`,
      `import { b } from "./b";`,
      ``,
      `function main() { return a() + b(); }`,
    ];
    const newBlock = [
      `function helper(x: number): number {`,
      `  if (x < 0) throw new Error("negative");`,
      `  return Math.floor(x * 1.5);`,
      `}`,
      ``,
    ];
    const ours = [...base.slice(0, 2), ``, ...newBlock, ...base.slice(2)];
    const theirs = [...base.slice(0, 2), ``, ...newBlock, ...base.slice(2)];

    const moves = detectBlockMove(base, ours, theirs);
    expect(moves.length).toBeGreaterThanOrEqual(1);
    // Le bloc retrouvé doit contenir au moins une ligne caractéristique.
    const flattened = moves.flatMap((m) => m.block).join("\n");
    expect(flattened).toContain("function helper");
    expect(flattened).toContain("Math.floor");
    // basePos doit être null (le bloc n'existe pas dans base).
    expect(moves.every((m) => m.basePos === null)).toBe(true);
  });
});

describe("detectBlockMove — anti-faux-positifs", () => {
  it("ignore les blocs à très faible diversité de tokens", () => {
    // Un bloc de 5 lignes de '}' (cas dégénéré, 1 seul token distinct).
    // minTokenDiversity=4 doit le rejeter.
    const trivialBlock = [`}`, `}`, `}`, `}`, `}`];
    const base = [`const a = 1;`];
    const ours = [...base, ...trivialBlock];
    const theirs = [...base, ...trivialBlock];
    const moves = detectBlockMove(base, ours, theirs);
    expect(moves).toEqual([]);
  });

  it("résiste aux collisions de hash via confirmation littérale", () => {
    // On ne peut pas garantir une collision, mais on peut vérifier que des
    // contenus différents ne sont pas mergés.
    const base = ["unrelated"];
    const ours = ["aaa", "bbb", "ccc", "ddd", "eee"];
    const theirs = ["xxx", "yyy", "zzz", "www", "vvv"];
    expect(detectBlockMove(base, ours, theirs)).toEqual([]);
  });
});

describe("detectBlockMove — compaction des blocs adjacents", () => {
  it("fusionne les fenêtres qui forment un bloc unique de longueur > W", () => {
    // Bloc de 8 lignes commun à ours et theirs, mais avec un préambule
    // *différent* de chaque côté pour ne pas contaminer le candidat avec des
    // matches incidentels. Avec W=5 le bloc fait 4 fenêtres qui se
    // chevauchent ; on attend la compaction en 1 seul MovedBlock de 8 lignes.
    const newBlock = [
      `class Cache<T> {`,
      `  private store: Map<string, T> = new Map();`,
      `  get(key: string): T | undefined { return this.store.get(key); }`,
      `  set(key: string, value: T): void { this.store.set(key, value); }`,
      `  delete(key: string): boolean { return this.store.delete(key); }`,
      `  clear(): void { this.store.clear(); }`,
      `  size(): number { return this.store.size; }`,
      `}`,
    ];
    const base = [`const cache = new Map();`, `// existing comment`];
    // Préambules de longueur ≥ W et différents des deux côtés → aucun match
    // avant le bloc.
    const oursPrefix = [`// ours-only-1`, `// ours-only-2`, `// ours-only-3`, `// ours-only-4`, `// ours-only-5`];
    const theirsPrefix = [`// theirs-only-1`, `// theirs-only-2`, `// theirs-only-3`, `// theirs-only-4`, `// theirs-only-5`];
    const ours = [...oursPrefix, ...newBlock];
    const theirs = [...theirsPrefix, ...newBlock];

    const moves = detectBlockMove(base, ours, theirs);
    expect(moves.length).toBe(1);
    expect(moves[0].block.length).toBe(newBlock.length);
    expect(moves[0].block[0]).toBe(`class Cache<T> {`);
    expect(moves[0].block[moves[0].block.length - 1]).toBe(`}`);
  });
});

describe("detectBlockMove — bloc qui existait dans base et qu'on déplace", () => {
  it("le bloc présent à un autre endroit de base est repéré comme déplacé", () => {
    const block = [
      `export interface Logger {`,
      `  info(msg: string): void;`,
      `  warn(msg: string): void;`,
      `  error(msg: string): void;`,
      `}`,
    ];
    // base : bloc en début, suivi d'autres lignes différentes des préambules
    const base = [
      ...block,
      ``,
      `const baseOnlyA = 1;`,
      `const baseOnlyB = 2;`,
      `const baseOnlyC = 3;`,
      `const baseOnlyD = 4;`,
      `const baseOnlyE = 5;`,
    ];
    // ours : bloc déplacé en fin, préambule unique
    const oursPrefix = [`// ours-1`, `// ours-2`, `// ours-3`, `// ours-4`, `// ours-5`];
    const ours = [...oursPrefix, ``, ...block];
    // theirs : préambule différent + même bloc déplacé
    const theirsPrefix = [`// theirs-1`, `// theirs-2`, `// theirs-3`, `// theirs-4`, `// theirs-5`];
    const theirs = [...theirsPrefix, ``, ...block];

    const moves = detectBlockMove(base, ours, theirs);
    expect(moves.length).toBeGreaterThanOrEqual(1);
    // basePos doit être renseigné (le bloc existe aussi dans base) et
    // distinct de oursPos / theirsPos.
    const found = moves.find((m) => m.block.includes(`export interface Logger {`));
    expect(found).toBeDefined();
    expect(found!.basePos).toBe(0);
    expect(found!.oursPos).toBeGreaterThan(0);
  });
});
