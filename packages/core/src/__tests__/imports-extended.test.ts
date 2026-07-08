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

  it("les commentaires et lignes vides restent tolérés (comportement existant inchangé)", () => {
    const result = tryResolveImportConflict(
      ['import { a } from "./a";'],
      ["// utils", 'import { a } from "./a";', ""],
      ['import { a } from "./a";', 'import { b } from "./b";'],
    );
    expect(result.mergedLines).not.toBeNull();
    expect(result.mergedLines!.join("\n")).toContain('"./b"');
  });
});
