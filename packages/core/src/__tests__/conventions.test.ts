/**
 * accuracy lot F — Conventions de dépôt : dérivation pure et consommation.
 *
 * Dérivation : verdicts uniquement au-dessus des planchers (≥5 échantillons,
 * ≥80 % d'accord), preuve contradictoire → pas de verdict, provenance stampée.
 * Consommation : `.gitwandrc`/appelant > convention > défaut, et toute
 * résolution influencée porte la provenance dans sa raison.
 */

import { describe, expect, it } from "vitest";
import { deriveConventions, resolve, type ConventionObservation, type RepoConventions } from "../index.js";

const META = { mergesReplayed: 40, derivedAt: "2026-08-26T12:00:00Z", engineVersion: "3.8.0" };

const obs = (
  question: ConventionObservation["question"],
  candidates: Record<string, boolean>,
  bucket?: string,
): ConventionObservation => ({ question, path: "x", candidates, ...(bucket ? { bucket } : {}) });

describe("deriveConventions — planchers de preuve", () => {
  it("stamps evidence and derives nothing from nothing", () => {
    const c = deriveConventions([], META);
    expect(c.evidence).toEqual({ ...META, conflictedFiles: 0 });
    expect(c.generatedFiles).toBeUndefined();
    expect(c.changelog).toBeUndefined();
  });

  it("no verdict below MIN_SAMPLES (4 unanimous samples are not enough)", () => {
    const c = deriveConventions(Array(4).fill(obs("generatedFiles", { merge: false })), META);
    expect(c.generatedFiles).toBeUndefined();
  });

  it("verdict 'regenerate' when semantic merges never match what ships", () => {
    const c = deriveConventions(Array(6).fill(obs("generatedFiles", { merge: false })), META);
    expect(c.generatedFiles).toEqual({ verdict: "regenerate", samples: 6, agreement: 1 });
  });

  it("verdict 'merge' when semantic merges match what ships", () => {
    const c = deriveConventions(
      [...Array(9).fill(obs("generatedFiles", { merge: true })), obs("generatedFiles", { merge: false })],
      META,
    );
    expect(c.generatedFiles?.verdict).toBe("merge");
    expect(c.generatedFiles?.agreement).toBeCloseTo(0.9);
  });

  it("contradictory evidence (50/50) yields NO verdict", () => {
    const c = deriveConventions(
      [...Array(5).fill(obs("generatedFiles", { merge: true })), ...Array(5).fill(obs("generatedFiles", { merge: false }))],
      META,
    );
    expect(c.generatedFiles).toBeUndefined();
  });

  it("changelog: neither union nor target matching → 'tool-rebuilt'", () => {
    const c = deriveConventions(
      Array(7).fill(obs("changelog", { union: false, "target-structure": false })),
      META,
    );
    expect(c.changelog?.verdict).toBe("tool-rebuilt");
  });

  it("changelog: union matches → 'union'", () => {
    const c = deriveConventions(Array(6).fill(obs("changelog", { union: true, "target-structure": false })), META);
    expect(c.changelog?.verdict).toBe("union");
  });

  it("pathPolicies: both sides matching means the evidence is worthless", () => {
    const c = deriveConventions(
      Array(6).fill(obs("pathPolicy", { "prefer-ours": true, "prefer-theirs": true }, "**/*.md")),
      META,
    );
    expect(c.pathPolicies).toBeUndefined();
  });

  it("pathPolicies: a clear one-sided family is reported", () => {
    const c = deriveConventions(
      Array(6).fill(obs("pathPolicy", { "prefer-ours": false, "prefer-theirs": true }, "**/*.snap")),
      META,
    );
    expect(c.pathPolicies).toEqual([{ glob: "**/*.snap", policy: "prefer-theirs", samples: 6, agreement: 1 }]);
  });
});

describe("conventions — consumption precedence and provenance", () => {
  const lockConflict = [
    "{",
    '  "lockfileVersion": 3,',
    "<<<<<<< ours",
    '  "pkg-a": "1.0.0",',
    "||||||| base",
    "=======",
    '  "pkg-b": "2.0.0",',
    ">>>>>>> theirs",
    '  "end": true',
    "}",
  ].join("\n");

  const mergeConv: RepoConventions = {
    evidence: { mergesReplayed: 40, conflictedFiles: 12, derivedAt: "x", engineVersion: "3.8.0" },
    generatedFiles: { verdict: "merge", samples: 12, agreement: 0.92 },
  };

  it("generatedFiles 'merge' convention enables auto-resolution, with provenance in the reason", () => {
    const result = resolve(lockConflict, "package-lock.json", { conventions: mergeConv });
    expect(result.stats.autoResolved).toBeGreaterThan(0);
    expect(result.resolutions[0].resolutionReason).toContain("convention measured on 12 merges");
  });

  it("an explicit caller choice beats the convention (.gitwandrc precedence)", () => {
    const result = resolve(lockConflict, "package-lock.json", {
      conventions: mergeConv,
      resolveGeneratedFiles: false,
    });
    expect(result.stats.autoResolved).toBe(0);
    expect(result.resolutions[0].resolutionReason).not.toContain("convention measured");
  });

  it("'regenerate' convention keeps the decline and confirms it with provenance", () => {
    const regen: RepoConventions = {
      ...mergeConv,
      generatedFiles: { verdict: "regenerate", samples: 9, agreement: 1 },
    };
    const result = resolve(lockConflict, "package-lock.json", { conventions: regen });
    expect(result.stats.autoResolved).toBe(0);
    expect(result.resolutions[0].resolutionReason).toContain("regenerates its generated files");
  });

  it("'tool-rebuilt' changelog convention declines the union with provenance", () => {
    const changelog = [
      "# Changelog",
      "",
      "<<<<<<< ours",
      "- feat A",
      "=======",
      "- feat B",
      ">>>>>>> theirs",
    ].join("\n");
    const conv: RepoConventions = {
      evidence: { mergesReplayed: 30, conflictedFiles: 8, derivedAt: "x", engineVersion: "3.8.0" },
      changelog: { verdict: "tool-rebuilt", samples: 8, agreement: 0.94 },
    };
    const withConv = resolve(changelog, "CHANGELOG.md", { conventions: conv });
    expect(withConv.stats.autoResolved).toBe(0);
    expect(withConv.resolutions[0].resolutionReason).toContain("release tooling");
    // ...et sans convention, l'union markdown fait son travail habituel.
    const without = resolve(changelog, "CHANGELOG.md");
    expect(without.stats.autoResolved).toBe(1);
  });

  it("conventions never touch files they are not about", () => {
    const ts = ["<<<<<<< ours", "const x = 1;", "||||||| base", "const x = 0;", "=======", "const x = 0;", ">>>>>>> theirs"].join("\n");
    const a = resolve(ts, "src/a.ts", { conventions: mergeConv });
    const b = resolve(ts, "src/a.ts");
    expect(a.mergedContent).toBe(b.mergedContent);
  });
});
