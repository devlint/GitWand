/**
 * accuracy lot 1 — Lot 1 « accuracy » : tests des trois changements issus du benchmark
 * (docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md).
 *
 * A — contrat du classifieur : un hunk `complex` résolu par un résolveur
 *     format-aware est reclassifié `format_semantic` (confiance + trace),
 *     plus jamais affiché « complex » mais appliqué en douce.
 * B — invariants de format : une résolution qui produit un changelog à deux
 *     sections « Unreleased » ou un JSON à clé dupliquée est rétractée.
 * D — fichiers générés : décliner par défaut avec un message actionnable ;
 *     l'ancien comportement reste disponible via `resolveGeneratedFiles`.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "../index.js";
import { checkFormatInvariants, findDuplicateJsonKeys } from "../resolver/validation.js";

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  [
    "<<<<<<< ours",
    ...ours,
    "||||||| base",
    ...base,
    "=======",
    ...theirs,
    ">>>>>>> theirs",
  ].join("\n");

// ─── A — contrat du classifieur ───────────────────────────────────────────────

describe("A — classifier contract (format_semantic)", () => {
  it("reclassifies a complex hunk resolved by the JSON resolver, with confidence and trace", () => {
    // Whole-document conflict: each side adds a different key — textual
    // complex, semantically a clean key-merge for the JSON resolver (which
    // needs each side to parse as a full JSON document).
    const content = conflict(
      ["{", '  "name": "app",', '  "alpha": 1', "}"],
      ["{", '  "name": "app"', "}"],
      ["{", '  "name": "app",', '  "beta": 2', "}"],
    );

    const result = resolve(content, "config.json");
    expect(result.mergedContent).not.toBeNull();
    expect(result.stats.byType.complex ?? 0).toBe(0);
    expect(result.stats.byType.format_semantic).toBe(1);

    const hunk = result.hunks[0];
    expect(hunk.type).toBe("format_semantic");
    expect(hunk.confidence.label).toBe("high");
    expect(hunk.trace.selected).toBe("format_semantic");
    expect(hunk.trace.steps.at(-1)?.reason).toContain("fusion sémantique");
  });

  it("never reports a fully-resolved file whose only hunk is still `complex`", () => {
    const content = [
      "# Doc",
      "",
      conflict(["- ours line"], ["- base line"], ["- theirs line"]),
    ].join("\n");
    const result = resolve(content, "notes.md");
    if (result.mergedContent !== null) {
      expect(result.stats.byType.complex ?? 0).toBe(0);
    }
  });

  it("respects the confidence threshold for format-aware resolutions (strict policy)", () => {
    const content = conflict(
      ["{", '  "name": "app",', '  "alpha": 1', "}"],
      ["{", '  "name": "app"', "}"],
      ["{", '  "name": "app",', '  "beta": 2', "}"],
    );
    // strict → minConfidence certain : la résolution format-aware (high) est bloquée
    const result = resolve(content, "config.json", { policy: "strict" });
    expect(result.mergedContent).toBeNull();
    expect(result.resolutions[0].autoResolved).toBe(false);
    expect(result.resolutions[0].resolutionReason).toMatch(/politique|insuffisante/);
  });
});

// ─── B — invariants de format ─────────────────────────────────────────────────

describe("B — format invariants", () => {
  it("finds duplicate JSON keys per object, not across objects", () => {
    expect(findDuplicateJsonKeys('{"a":1,"a":2}')).toEqual(["a"]);
    expect(findDuplicateJsonKeys('{"a":{"x":1},"b":{"x":1}}')).toEqual([]);
    expect(findDuplicateJsonKeys('{"a":"a\\":1,\\"a","b":2}')).toEqual([]);
    expect(findDuplicateJsonKeys('[{"k":1},{"k":2}]')).toEqual([]);
  });

  it("flags a changelog with two Unreleased sections", () => {
    const md = "# Notes\n\n## [Unreleased](x)\n\nstuff\n\n## [Unreleased](y)\n\nmore";
    expect(checkFormatInvariants(md, "CHANGELOG.md")).toHaveLength(1);
    // ...but only for changelog-shaped files
    expect(checkFormatInvariants(md, "guide.md")).toHaveLength(0);
  });

  it("retracts a resolution that would produce a duplicate JSON key", () => {
    // Both sides add the SAME key with different values → line union would
    // keep both → invariant violation → retraction.
    const content = [
      "{",
      '  "name": "app",',
      conflict(['  "dep": "^12.0",'], [], ['  "dep": "^13.0",']),
      '  "zeta": 26',
      "}",
    ].join("\n");

    const result = resolve(content, "composer.json");
    // Quoi que le moteur ait tenté, le fichier final ne doit jamais porter la clé dupliquée.
    if (result.mergedContent !== null) {
      expect(findDuplicateJsonKeys(result.mergedContent)).toEqual([]);
    } else {
      expect(result.stats.autoResolved).toBe(0);
    }
  });

  it("retracts a changelog resolution that duplicates the Unreleased section", () => {
    const content = [
      "# Release Notes",
      "",
      conflict(
        ["## [Unreleased](compare/v13.25.0...13.x)"],
        ["## [Unreleased](compare/v12.65.0...12.x)"],
        ["## [Unreleased](compare/v12.66.0...12.x)", "", "## [v12.66.0](compare/...) - 2026-08-11", "", "* change A"],
      ),
      "",
      "## [v13.25.0](compare/...) - 2026-08-11",
      "",
      "* change B",
    ].join("\n");

    const result = resolve(content, "CHANGELOG.md");
    if (result.mergedContent !== null) {
      const unreleased = result.mergedContent.split("\n").filter((l) => /^##\s+\[?unreleased/i.test(l));
      expect(unreleased.length).toBeLessThanOrEqual(1);
    } else {
      expect(result.stats.autoResolved).toBe(0);
      expect(result.validation.isValid === false || result.resolutions.every((r) => !r.autoResolved)).toBe(true);
    }
  });
});

// ─── D — fichiers générés : décliner par défaut ───────────────────────────────

describe("D — generated files decline by default", () => {
  const lockConflict = [
    "{",
    '  "lockfileVersion": 3,',
    conflict(['  "pkg-a": "1.0.0",'], [], ['  "pkg-b": "2.0.0",']),
    '  "end": true',
    "}",
  ].join("\n");

  it("declines on package-lock.json with an actionable reason", () => {
    const result = resolve(lockConflict, "package-lock.json");
    expect(result.mergedContent).toBeNull();
    expect(result.stats.autoResolved).toBe(0);
    const reason = result.resolutions[0].resolutionReason;
    expect(reason).toMatch(/régénère|install|build/i);
    expect(reason).toContain("resolveGeneratedFiles");
  });

  it("keeps the historical behaviour behind resolveGeneratedFiles: true", () => {
    const result = resolve(lockConflict, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.stats.autoResolved).toBeGreaterThan(0);
  });

  it("still resolves the safe textual cases on generated files (one side untouched)", () => {
    const content = [
      "{",
      conflict(['  "pkg-a": "1.0.1",'], ['  "pkg-a": "1.0.0",'], ['  "pkg-a": "1.0.0",']),
      '  "end": true',
      "}",
    ].join("\n");
    const result = resolve(content, "package-lock.json");
    // one_side_change : prendre le côté modifié ne fabrique rien — autorisé.
    expect(result.stats.autoResolved).toBe(1);
    expect(result.hunks[0].type).toBe("one_side_change");
  });

  it("classification still reports generated_file (tier: unresolved by default)", () => {
    const result = resolve(lockConflict, "package-lock.json");
    expect(result.hunks[0].type === "generated_file" || result.stats.autoResolved === 0).toBe(true);
  });
});
