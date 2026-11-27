/**
 * Tests pour le résolveur d'imports étendu (Phase 8.1 — tri par groupes, Node builtins)
 */
import { describe, it, expect } from "vitest";
import { tryResolveImportConflict } from "../resolvers/imports.js";

describe("tryResolveImportConflict — extended", () => {
  it("should merge imports added on both sides for the same named module", () => {
    const base = [
      'import { useState } from "react";',
    ];
    const ours = [
      'import { useState, useEffect } from "react";',
    ];
    const theirs = [
      'import { useState, useCallback } from "react";',
    ];

    const result = tryResolveImportConflict(base, ours, theirs);

    expect(result.mergedLines).not.toBeNull();
    expect(result.unresolvedImports).toBe(0);
    // All three names should be present
    const merged = result.mergedLines!.join("\n");
    expect(merged).toContain("useCallback");
    expect(merged).toContain("useEffect");
    expect(merged).toContain("useState");
  });

  it("keeps the file's quotes on a merged named import", () => {
    const double = tryResolveImportConflict(
      ['import { a } from "./lib";'],
      ['import { a, c } from "./lib";'],
      ['import { a, b } from "./lib";'],
    );
    expect(double.mergedLines).toEqual(['import { a, b, c } from "./lib";']);
    const single = tryResolveImportConflict(
      ["import { a } from './lib';"],
      ["import { a, c } from './lib';"],
      ["import { a, b } from './lib';"],
    );
    expect(single.mergedLines).toEqual(["import { a, b, c } from './lib';"]);
    // The multi-line form too.
    const long = "aaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbb, cccccccccccccccccccc";
    const multi = tryResolveImportConflict(
      [`import { ${long} } from "./a-rather-long-module-path";`],
      [`import { ${long}, dddddddddddddddddddd } from "./a-rather-long-module-path";`],
      [`import { ${long}, eeeeeeeeeeeeeeeeeeee } from "./a-rather-long-module-path";`],
    );
    expect(multi.mergedLines?.join("\n")).toContain('} from "./a-rather-long-module-path";');
  });

  it("leaves an import line holding a comment to the textual engine", () => {
    // A comment can hold a `from "…"` (in either quote) the patterns would
    // take for the module.
    for (const comment of [`/* was: from 'old' */`, `/* from "y" */`]) {
      const r = tryResolveImportConflict(
        ['import { a } from "./lib";'],
        ['import { a, c } from "./lib";'],
        [`import { a, ${comment} b } from "./lib";`],
      );
      expect(r.mergedLines).toBeNull();
    }
    // A URL module is not a comment.
    const url = tryResolveImportConflict(
      ['import { a } from "https://deno.land/x/lib.ts";'],
      ['import { a, c } from "https://deno.land/x/lib.ts";'],
      ['import { a, b } from "https://deno.land/x/lib.ts";'],
    );
    expect(url.mergedLines).toEqual(['import { a, b, c } from "https://deno.land/x/lib.ts";']);
  });

  it("takes the quote and semicolon theirs alone changed", () => {
    const r = tryResolveImportConflict(
      ["import { a } from './lib'"],
      ["import { a, c } from './lib'"],
      ['import { a, b } from "./lib";'],
    );
    expect(r.mergedLines).toEqual(['import { a, b, c } from "./lib";']);
  });

  it("leaves the same import added at two indentations to the textual engine", () => {
    const r = tryResolveImportConflict(
      [],
      ['  import x from "x";'],
      ['    import x from "x";'],
    );
    expect(r.mergedLines).toBeNull();
  });

  it("leaves a named import added at two indentations to the textual engine", () => {
    const r = tryResolveImportConflict(
      [],
      ['  import { a } from "x";'],
      ['    import { b } from "x";'],
    );
    expect(r.mergedLines).toBeNull();
  });

  it("takes an import both sides added as the same when one re-indented the block", () => {
    const r = tryResolveImportConflict(
      ['import a from "a";'],
      ['  import a from "a";', '  import x from "x";'],
      ['import a from "a";', 'import x from "x";'],
    );
    expect(r.mergedLines).toEqual(['  import a from "a";', '  import x from "x";']);
  });

  it("says why a commented import line is not merged", () => {
    const r = tryResolveImportConflict(
      ['import { a } from "./lib";'],
      ['import { a, c } from "./lib";'],
      ['import { a, /* legacy */ b } from "./lib";'],
    );
    expect(r.reason).toMatch(/holds a comment/);
  });

  it("does not drop a re-indent against a deletion", () => {
    const r = tryResolveImportConflict(
      ['import x from "x";', 'import y from "y";'],
      ['  import x from "x";', 'import y from "y";'],
      ['import y from "y";'],
    );
    expect(r.mergedLines).toBeNull();
  });

  it("leaves a commented import in the base to the textual engine", () => {
    const r = tryResolveImportConflict(
      ['import { a, /* b */ b } from "./lib";'],
      ['import { a } from "./lib";'],
      ['import { a, b, c } from "./lib";'],
    );
    expect(r.mergedLines).toBeNull();
  });

  it("leaves two different re-indentations of a line to the textual engine", () => {
    const r = tryResolveImportConflict(
      ['import x from "x";'],
      ['  import x from "x";'],
      ['    import x from "x";'],
    );
    expect(r.mergedLines).toBeNull();
  });

  it("gives a line the other side added the block's new indentation", () => {
    const r = tryResolveImportConflict(
      ['import a from "a";'],
      ['  import a from "a";'],
      ['import a from "a";', 'import b from "b";'],
    );
    expect(r.mergedLines).toEqual(['  import a from "a";', '  import b from "b";']);
  });

  it("keeps the indentation of the import lines", () => {
    const r = tryResolveImportConflict(
      ['  import { a } from "./lib";', '  import x from "x";'],
      ['  import { a, c } from "./lib";', '  import x from "x";'],
      ['  import { a, b } from "./lib";', '  import x from "x";'],
    );
    // Sorted by group: the package first, then the relative module.
    expect(r.mergedLines).toEqual(['  import x from "x";', '  import { a, b, c } from "./lib";']);
  });

  it("keeps the indentation a single side gave a line", () => {
    const r = tryResolveImportConflict(
      ['import x from "x";', 'import { a } from "./lib";'],
      ['  import x from "x";', 'import { a } from "./lib";'],
      ['import x from "x";', 'import { a, b } from "./lib";'],
    );
    expect(r.mergedLines).toEqual(['  import x from "x";', 'import { a, b } from "./lib";']);
  });

  it("sorts a merged import written over several lines as one statement", () => {
    const long = "aaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbb, cccccccccccccccccccc";
    const r = tryResolveImportConflict(
      [`import { ${long} } from "./a-rather-long-module-path";`, 'import x from "x";'],
      [`import { ${long}, dddddddddddddddddddd } from "./a-rather-long-module-path";`, 'import x from "x";'],
      [`import { ${long}, eeeeeeeeeeeeeeeeeeee } from "./a-rather-long-module-path";`, 'import x from "x";'],
    );
    const lines = r.mergedLines!;
    // The package first, then the relative module, its lines together.
    expect(lines[0]).toBe('import x from "x";');
    expect(lines[1]).toBe("import {");
    expect(lines.at(-1)).toBe('} from "./a-rather-long-module-path";');
  });

  it("should merge when ours adds a new module and theirs adds a different one", () => {
    const base = [
      'import React from "react";',
    ];
    const ours = [
      'import React from "react";',
      'import { formatDate } from "./utils";',
    ];
    const theirs = [
      'import React from "react";',
      'import axios from "axios";',
    ];

    const result = tryResolveImportConflict(base, ours, theirs);

    expect(result.mergedLines).not.toBeNull();
    expect(result.unresolvedImports).toBe(0);
    const merged = result.mergedLines!.join("\n");
    expect(merged).toContain('axios');
    expect(merged).toContain('./utils');
    expect(merged).toContain('react');
  });

  it("should sort Node builtins before npm packages", () => {
    const base: string[] = [];
    const ours = [
      'import path from "path";',
    ];
    const theirs = [
      'import axios from "axios";',
    ];

    const result = tryResolveImportConflict(base, ours, theirs);

    expect(result.mergedLines).not.toBeNull();
    const lines = result.mergedLines!.filter(l => l.trim());
    // path (built-in) should come before axios (npm)
    const pathIdx = lines.findIndex(l => l.includes("path"));
    const axiosIdx = lines.findIndex(l => l.includes("axios"));
    expect(pathIdx).toBeLessThan(axiosIdx);
  });

  it("should handle TypeScript type imports alongside value imports", () => {
    const base = [
      'import { useState } from "react";',
    ];
    const ours = [
      'import { useState } from "react";',
      'import type { FC } from "react";',
    ];
    const theirs = [
      'import { useState, useRef } from "react";',
    ];

    const result = tryResolveImportConflict(base, ours, theirs);

    expect(result.mergedLines).not.toBeNull();
    const merged = result.mergedLines!.join("\n");
    expect(merged).toContain("type");
    expect(merged).toContain("useRef");
    expect(merged).toContain("useState");
  });

  it("should detect conflict when same module imported incompatibly", () => {
    const base: string[] = [];
    const ours = [
      'import * as React from "react";',
    ];
    const theirs = [
      'import React from "react";',
    ];

    const result = tryResolveImportConflict(base, ours, theirs);

    // Namespace vs default = conflict
    expect(result.mergedLines).toBeNull();
    expect(result.unresolvedImports).toBeGreaterThan(0);
  });
});

describe("tryResolveImportConflict — lignes import-like non parsables (garde anti-perte)", () => {
  // Régression : un bloc accepté par isImportBlock() mais dont les lignes
  // parsent en `unknown` (ex: `import a` sans from) retournait
  // "Fusion réussie : 0 import(s)" avec mergedLines: [] — le contenu du hunk
  // était SUPPRIMÉ silencieusement. Le resolver doit se déclarer non
  // applicable (mergedLines: null) dès qu'un côté contient du contenu
  // import-like qu'il ne sait pas représenter.

  it("bloc entièrement non parsable → mergedLines null, pas un succès vide", () => {
    const result = tryResolveImportConflict([], ["import a", "", "import b"], ["import b", "import a"]);
    expect(result.mergedLines).toBeNull();
  });

  it("mélange parsable + non parsable → bail out (sinon la ligne inconnue serait droppée)", () => {
    const result = tryResolveImportConflict(
      [],
      ['import { a } from "./a";', "import weird"],
      ['import { b } from "./b";'],
    );
    expect(result.mergedLines).toBeNull();
  });

  it("leaves a block holding a comment line to the textual engine, which keeps it", () => {
    // Only imports are written back: merging here would drop `// utils`.
    const result = tryResolveImportConflict(
      ['import { a } from "./a";'],
      ["// utils", 'import { a } from "./a";', ""],
      ['import { a } from "./a";', 'import { b } from "./b";'],
    );
    expect(result.mergedLines).toBeNull();
    // One side added imports: the textual engine may take it over.
    expect(result.conflict).toBeUndefined();
  });

  it("blank lines alone are still tolerated", () => {
    const result = tryResolveImportConflict(
      ['import { a } from "./a";'],
      ['import { a } from "./a";', ""],
      ['import { a } from "./a";', 'import { b } from "./b";'],
    );
    expect(result.mergedLines!.join("\n")).toContain('"./b"');
  });

  it("leaves a commented block to the textual engine when the additions bind different names", () => {
    const result = tryResolveImportConflict(
      ["// @ts-nocheck", 'import a from "a";'],
      ["// @ts-nocheck", 'import a from "a";', 'import b from "b";'],
      ["// @ts-nocheck", 'import c from "c";', 'import a from "a";'],
    );
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBeUndefined();
  });

  it("does not take the same addition, or two edits of a base import, for a clash", () => {
    const same = tryResolveImportConflict([], ["// polyfills", 'import a from "a";'], ['import a from "a";']);
    expect(same.conflict).toBeUndefined();
    const edits = tryResolveImportConflict(
      ["// deps", 'import { a } from "./lib";'],
      ["// deps", 'import { a, b } from "./lib";'],
      ["// deps", 'import { a, c } from "./lib";'],
    );
    expect(edits.conflict).toBeUndefined();
  });

  it("counts an import whose bindings cannot be read as a possible clash", () => {
    const r = tryResolveImportConflict(
      ["// deps"],
      ["// deps", 'const { x: { b } } = require("m");'],
      ["// deps", 'import { b } from "n";'],
    );
    expect(r.conflict).toBe(true);
  });

  it("keeps a clean deletion when the other side re-indented the block", () => {
    const r = tryResolveImportConflict(
      ['import x from "x";', 'import y from "y";'],
      ['import y from "y";'],
      ['  import x from "x";', '  import y from "y";'],
    );
    expect(r.mergedLines).toEqual(['  import y from "y";']);
  });

  it("does not take a doc comment for a binding clash", () => {
    const doc = tryResolveImportConflict(
      ['import a from "a";'],
      ['import a from "a";', "/**", " * Polyfills", " */", 'import "core-js";'],
      ['import a from "a";', 'import b from "b";'],
    );
    expect(doc.mergedLines).toBeNull();
    expect(doc.conflict).toBeUndefined();
  });

  it("hands a commented block where both sides added imports to the user", () => {
    const result = tryResolveImportConflict(
      [],
      ['import { a } from "x"; // used by foo'],
      ['import { a, b } from "x";'],
    );
    expect(result.mergedLines).toBeNull();
    expect(result.conflict).toBe(true);
    expect(result.reason).toMatch(/bind the same name/);
  });

  it("hands the same module added at two indentations to the user", () => {
    const result = tryResolveImportConflict([], ['  import { a } from "x";'], ['    import { a, b } from "x";']);
    expect(result.conflict).toBe(true);
  });
});
