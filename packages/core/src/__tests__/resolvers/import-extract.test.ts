/**
 * extractImportSources (C0, v3.6.0) — pure extraction of import module
 * specifiers from arbitrary file content, for the PR-review dependency hop
 * (C1). Extraction only, no resolved graph (that's v4.0).
 */
import { describe, it, expect } from "vitest";
import { extractImportSources } from "../../resolvers/imports.js";

describe("extractImportSources", () => {
  it("extracts a named import source", () => {
    expect(extractImportSources(`import { useState } from 'react';`)).toEqual(["react"]);
  });

  it("extracts a relative import source", () => {
    expect(extractImportSources(`import { helper } from '../utils';`)).toEqual(["../utils"]);
  });

  it("extracts a side-effect import", () => {
    expect(extractImportSources(`import 'core-js/stable';`)).toEqual(["core-js/stable"]);
  });

  it("extracts a CommonJS require", () => {
    expect(extractImportSources(`const fs = require('fs');`)).toEqual(["fs"]);
  });

  it("extracts an `export … from` re-export", () => {
    // Braced named re-exports (`export { foo } from …`) aren't matched by
    // the shared RE_EXPORT_FROM regex — a pre-existing limitation of the
    // conflict-resolution regex this function reuses, not introduced here;
    // `export * from …` is the form it does support.
    expect(extractImportSources(`export * from './foo';`)).toEqual(["./foo"]);
  });

  it("dedupes repeated sources across multiple statements", () => {
    const content = [
      `import { a } from 'react';`,
      `import { b } from 'react';`,
      `import type { C } from 'react';`,
    ].join("\n");
    expect(extractImportSources(content)).toEqual(["react"]);
  });

  it("ignores non-import lines (comments, code, blank lines)", () => {
    const content = [
      `// a comment mentioning from 'nope'`,
      `function foo() { return 1; }`,
      ``,
      `import { real } from 'real-module';`,
    ].join("\n");
    expect(extractImportSources(content)).toEqual(["real-module"]);
  });

  it("returns [] for content with no imports", () => {
    expect(extractImportSources("const x = 1;\nfunction f() {}\n")).toEqual([]);
  });

  it("returns [] for empty content", () => {
    expect(extractImportSources("")).toEqual([]);
  });
});
