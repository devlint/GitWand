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
