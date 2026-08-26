/**
 * Tests du resolver lockfile-npm (package-lock.json) — GitWand
 *
 * Fixtures :
 *   F1 — package ajouté d'un seul côté
 *   F2 — même package, version différente → prefer theirs ou conflit
 *   F3 — lockfile minimal (structure vide)
 *   F4 — dépendances directes ajoutées des deux côtés (différents packages)
 *   F5 — détection du nom `package-lock.json` → bon resolver utilisé
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";
// accuracy lot 1 — les lockfiles déclinent par défaut (fichiers générés) ; ces suites
// testent le résolveur sémantique lui-même, donc derrière l'opt-in resolveGeneratedFiles.


// ─── helpers ──────────────────────────────────────────────────────────────────

function makeLock(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "my-app",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "my-app", version: "1.0.0" },
        "node_modules/react": {
          version: "18.2.0",
          resolved: "https://registry.npmjs.org/react/-/react-18.2.0.tgz",
          integrity: "sha512-react",
        },
        ...extra,
      },
    },
    null,
    2,
  );
}

// ─── F1 — package ajouté d'un seul côté ───────────────────────────────────────

describe("F1 — package-lock.json : package ajouté d'un seul côté (diff3)", () => {
  const base = makeLock();
  const ours = makeLock({
    "node_modules/lodash": {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-lodash",
    },
  });

  const input = [
    `<<<<<<< ours`,
    ...ours.split("\n"),
    `||||||| base`,
    ...base.split("\n"),
    `=======`,
    ...base.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver lockfile-npm", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient le package ajouté", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.mergedContent).toContain("lodash");
    expect(result.mergedContent).toContain("react");
  });

  it("la raison mentionne [lockfile-npm]", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-npm\]/i);
  });
});

// ─── F2 — même package, version différente ────────────────────────────────────

describe("F2 — package-lock.json : même package, version différente (diff3)", () => {
  const base = makeLock();
  const ours = makeLock({
    "node_modules/lodash": {
      version: "4.17.20",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      integrity: "sha512-old",
    },
  });
  const theirs = makeLock({
    "node_modules/lodash": {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-new",
    },
  });

  const input = [
    `<<<<<<< ours`,
    ...ours.split("\n"),
    `||||||| base`,
    ...base.split("\n"),
    `=======`,
    ...theirs.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "package-lock.json", { resolveGeneratedFiles: true })).not.toThrow();
  });

  it("la raison mentionne [lockfile-npm]", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-npm\]/i);
  });
});

// ─── F3 — lockfile minimal ────────────────────────────────────────────────────

describe("F3 — package-lock.json minimal : ne plante pas", () => {
  const minimal = JSON.stringify(
    { name: "test", version: "1.0.0", lockfileVersion: 3, packages: {} },
    null,
    2,
  );

  const input = [
    `<<<<<<< ours`,
    ...minimal.split("\n"),
    `||||||| base`,
    ...minimal.split("\n"),
    `=======`,
    ...minimal.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "package-lock.json", { resolveGeneratedFiles: true })).not.toThrow();
  });

  it("produit un résultat avec au moins un hunk", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.hunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── F4 — dépendances différentes ajoutées des deux côtés ────────────────────

describe("F4 — package-lock.json : packages différents ajoutés des deux côtés (diff3)", () => {
  const base = makeLock();
  const ours = makeLock({
    "node_modules/axios": {
      version: "1.6.0",
      resolved: "https://registry.npmjs.org/axios/-/axios-1.6.0.tgz",
      integrity: "sha512-axios",
    },
  });
  const theirs = makeLock({
    "node_modules/date-fns": {
      version: "3.0.0",
      resolved: "https://registry.npmjs.org/date-fns/-/date-fns-3.0.0.tgz",
      integrity: "sha512-datefns",
    },
  });

  const input = [
    `<<<<<<< ours`,
    ...ours.split("\n"),
    `||||||| base`,
    ...base.split("\n"),
    `=======`,
    ...theirs.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver lockfile-npm", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient les deux packages", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.mergedContent).toContain("axios");
    expect(result.mergedContent).toContain("date-fns");
    expect(result.mergedContent).toContain("react");
  });

  it("la raison mentionne [lockfile-npm]", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-npm\]/i);
  });
});

// ─── F5 — détection du nom de fichier ────────────────────────────────────────

describe("F5 — package-lock.json : détection du nom de fichier", () => {
  const base = makeLock();
  const ours = makeLock({
    "node_modules/vue": {
      version: "3.4.0",
      resolved: "https://registry.npmjs.org/vue/-/vue-3.4.0.tgz",
      integrity: "sha512-vue",
    },
  });

  const input = [
    `<<<<<<< ours`,
    ...ours.split("\n"),
    `||||||| base`,
    ...base.split("\n"),
    `=======`,
    ...base.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("le nom package-lock.json active le bon resolver", () => {
    const result = resolve(input, "package-lock.json", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-npm\]/i);
  });

  it("le nom dans un sous-dossier est aussi détecté", () => {
    const result = resolve(input, "apps/frontend/package-lock.json", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-npm\]/i);
  });
});
