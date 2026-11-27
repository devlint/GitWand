/**
 * Résolveur d'imports — liaisons locales (lot 3.15.x A).
 *
 * Régressions : `oursBySource`/`theirsBySource` ne gardaient que le dernier
 * import de chaque module, si bien qu'un `import X` d'un côté face à
 * `import { a, X }` + `import type { T }` du même module de l'autre côté
 * n'était comparé qu'à `type { T }` : aucune collision vue, le moteur textuel
 * gardait les deux lignes et `X` était déclaré deux fois. Et les liaisons d'un
 * `require` n'étaient pas lues : tout `require` face à un import du même
 * module comptait comme une collision.
 */
import { describe, it, expect } from "vitest";
import { tryResolveImportConflict } from "../resolvers/imports.js";
import { resolve } from "../resolver.js";

const tsHunk = (ours: string[], base: string[], theirs: string[]) =>
  [`<<<<<<< ours`, ...ours, `||||||| base`, ...base, `=======`, ...theirs, `>>>>>>> theirs`, ``, `export const x = 1;`].join("\n");

describe("imports — toutes les déclarations du même module comptent", () => {
  it("`import X` face à `{ a, X }` + `import type { T }` : collision signalée, X jamais déclaré deux fois", () => {
    const ours = [`import X from 'm';`];
    const theirs = [`import { a, X } from 'm';`, `import type { T } from 'm';`];
    const result = tryResolveImportConflict([], ours, theirs);
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);

    // Avant : le moteur textuel prenait le relais et gardait les deux lignes.
    expect(resolve(tsHunk(ours, [], theirs), "src/a.ts").stats.autoResolved).toBe(0);
  });

  it("symétrique : `{ a, X }` + `import type { T }` côté ours face à `import X`", () => {
    const result = tryResolveImportConflict([], [`import { a, X } from 'm';`, `import type { T } from 'm';`], [`import X from 'm';`]);
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
  });
});

describe("imports — liaisons d'un require", () => {
  it("`const fs = require('fs')` face à `import { readFile } from 'fs'` : pas de collision signalée", () => {
    const result = tryResolveImportConflict([], [`const fs = require('fs');`], [`import { readFile } from 'fs';`]);
    expect(result.conflict).toBeUndefined();
  });

  it("`const { readFile } = require('fs')` face à `import { readFile } from 'fs'` : collision signalée", () => {
    const result = tryResolveImportConflict([], [`const { readFile } = require('fs');`], [`import { readFile } from 'fs';`]);
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
  });

  it("un renommage `{ a: b }` déclare `b`", () => {
    const clash = tryResolveImportConflict([], [`const { readFile: rf } = require('fs');`], [`import rf from 'fs';`]);
    expect(clash.conflict).toBe(true);
    const noClash = tryResolveImportConflict([], [`const { readFile: rf } = require('fs');`], [`import readFile from 'fs';`]);
    expect(noClash.conflict).toBeUndefined();
  });

  it("une déstructuration imbriquée reste prudente (collision supposée)", () => {
    const result = tryResolveImportConflict([], [`const { a: { b } } = require('m');`], [`import c from 'm';`]);
    expect(result.conflict).toBe(true);
  });
});

describe("imports — review du lot A", () => {
  it("`import { X }` d'un côté, `import type { X }` de l'autre : collision signalée", () => {
    const result = tryResolveImportConflict([], [`import { X } from 'm';`], [`import type { X } from 'm';`]);
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
  });

  it("`import X` d'un côté, `import type X` de l'autre : collision signalée", () => {
    const result = tryResolveImportConflict([], [`import X from 'm';`], [`import type X from 'm';`]);
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
  });

  it("deux require du même module d'un côté : aucun n'est perdu", () => {
    const result = tryResolveImportConflict(
      [],
      [`const fs = require('fs');`, `const { readFile } = require('fs');`],
      [`import path from 'path';`],
    );
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBeUndefined();
    expect(result.reason).toMatch(/same module twice/);
  });

  it("plusieurs déclarateurs sur une ligne require : prudence (collision supposée)", () => {
    const result = tryResolveImportConflict([], [`const a = require('m'), b = require('n');`], [`import c from 'm';`]);
    expect(result.conflict).toBe(true);
  });
});

describe("imports — review du lot A, passe 2", () => {
  it("un import named ajouté face à un require illisible du même module : prudence (collision supposée)", () => {
    // Le moteur textuel garderait les deux lignes : si le motif illisible lie
    // le même nom, il serait déclaré deux fois.
    const result = tryResolveImportConflict([], [`import { b } from 'fs';`], [`const { a: { b } } = require('fs');`]);
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
  });

  it("un second déclarateur après un accès membre : prudence (collision supposée)", () => {
    const result = tryResolveImportConflict([], [`const x = require('m').default, y = require('m2');`], [`import y from 'm';`]);
    expect(result.conflict).toBe(true);
  });
});

describe("imports — review du lot A, passe 3", () => {
  it("type contre valeur : la raison le dit", () => {
    const result = tryResolveImportConflict([], [`import { X } from 'm';`], [`import type { X } from 'm';`]);
    expect(result.reason).toMatch(/type/);
    expect(result.reason).not.toMatch(/named vs named/);
  });
});

describe("imports — review du lot A, passe 4", () => {
  it("deux imports de base changés chacun d'un côté pour lier le même nom : collision signalée", () => {
    const result = tryResolveImportConflict(
      [`import { a } from 'm';`, `import Y from 'm';`],
      [`import { a, X } from 'm';`, `import Y from 'm';`],
      [`import { a } from 'm';`, `import X from 'm';`],
    );
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
  });

  it("une virgule dans un commentaire de fin de ligne n'est pas un second déclarateur", () => {
    const result = tryResolveImportConflict([], [`const fs = require('fs') // fs, sync`], [`import { readFile } from 'fs';`]);
    expect(result.conflict).toBeUndefined();
  });
});

describe("imports — review du lot A, passe 5", () => {
  it("un require illisible inchangé depuis la base ne bloque pas un ajout d'un autre module", () => {
    const base = [`const a = require('m'), b = require('n');`];
    const result = tryResolveImportConflict(base, [...base, `import { c } from 'm';`], [...base, `import p from 'p';`]);
    expect(result.conflict).toBeUndefined();
    expect(result.mergedLines).not.toBeNull();
  });
});
