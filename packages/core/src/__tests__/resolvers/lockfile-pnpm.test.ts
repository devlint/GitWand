/**
 * Tests du resolver lockfile-pnpm (pnpm-lock.yaml) — GitWand
 *
 * Fixtures :
 *   F1 — package ajouté dans `packages:` d'un seul côté
 *   F2 — même package, version différente → prefer theirs ou conflit
 *   F3 — lockfile minimal
 *   F4 — ajout dans `importers:` d'un seul côté
 *   F5 — détection du nom `pnpm-lock.yaml` → bon resolver utilisé
 */

import { describe, it, expect } from "vitest";
import { resolve } from "../../resolver.js";
// accuracy lot 1 — les lockfiles déclinent par défaut (fichiers générés) ; ces suites
// testent le résolveur sémantique lui-même, donc derrière l'opt-in resolveGeneratedFiles.


// ─── base lockfile ─────────────────────────────────────────────────────────────

const baseLock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .:
    dependencies:
      vue:
        specifier: ^3.4.0
        version: 3.4.0

packages:

  /vue@3.4.0:
    resolution: {integrity: sha512-vue}
    engines: {node: '>=16.11.0'}
`;

// ─── F1 — package ajouté dans packages: d'un seul côté ───────────────────────

describe("F1 — pnpm-lock.yaml : package ajouté dans packages: d'un seul côté (diff3)", () => {
  const oursLock = baseLock + `
  /axios@1.6.0:
    resolution: {integrity: sha512-axios}
    engines: {node: '>=16'}
`;

  const input = [
    `<<<<<<< ours`,
    ...oursLock.split("\n"),
    `||||||| base`,
    ...baseLock.split("\n"),
    `=======`,
    ...baseLock.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver lockfile-pnpm", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient le package ajouté", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.mergedContent).toContain("axios");
    expect(result.mergedContent).toContain("vue");
  });

  it("la raison mentionne [lockfile-pnpm]", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-pnpm\]/i);
  });
});

// ─── F2 — même package, version différente ────────────────────────────────────

describe("F2 — pnpm-lock.yaml : même package, version différente (diff3)", () => {
  const oursLock = baseLock.replace("3.4.0", "3.4.1").replace("sha512-vue", "sha512-vue-new");
  const theirsLock = baseLock.replace("3.4.0", "3.5.0").replace("sha512-vue", "sha512-vue-theirs");

  const input = [
    `<<<<<<< ours`,
    ...oursLock.split("\n"),
    `||||||| base`,
    ...baseLock.split("\n"),
    `=======`,
    ...theirsLock.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("ne lève pas d'exception", () => {
    expect(() => resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true })).not.toThrow();
  });

  it("la raison mentionne [lockfile-pnpm]", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-pnpm\]/i);
  });
});

// ─── F3 — lockfile minimal ────────────────────────────────────────────────────

describe("F3 — pnpm-lock.yaml minimal : ne plante pas", () => {
  const minimal = `lockfileVersion: '9.0'\n\npackages:\n`;

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
    expect(() => resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true })).not.toThrow();
  });

  it("produit un résultat avec au moins un hunk", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.hunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── F4 — ajout dans importers: d'un seul côté ───────────────────────────────

describe("F4 — pnpm-lock.yaml : ajout dans importers: d'un seul côté (diff3)", () => {
  const oursLock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      vue:
        specifier: ^3.4.0
        version: 3.4.0
      axios:
        specifier: ^1.6.0
        version: 1.6.0

packages:

  /vue@3.4.0:
    resolution: {integrity: sha512-vue}

  /axios@1.6.0:
    resolution: {integrity: sha512-axios}
`;

  const input = [
    `<<<<<<< ours`,
    ...oursLock.split("\n"),
    `||||||| base`,
    ...baseLock.split("\n"),
    `=======`,
    ...baseLock.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("auto-résout via le resolver lockfile-pnpm", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.stats.autoResolved).toBe(1);
  });

  it("le résultat contient la dépendance ajoutée dans importers", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.mergedContent).toContain("axios");
  });

  it("la raison mentionne [lockfile-pnpm]", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-pnpm\]/i);
  });
});

// ─── F5 — détection du nom de fichier ────────────────────────────────────────

describe("F5 — pnpm-lock.yaml : détection du nom de fichier", () => {
  const oursLock = baseLock + `
  /lodash@4.17.21:
    resolution: {integrity: sha512-lodash}
`;

  const input = [
    `<<<<<<< ours`,
    ...oursLock.split("\n"),
    `||||||| base`,
    ...baseLock.split("\n"),
    `=======`,
    ...baseLock.split("\n"),
    `>>>>>>> theirs`,
  ].join("\n");

  it("le nom pnpm-lock.yaml active le bon resolver", () => {
    const result = resolve(input, "pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-pnpm\]/i);
  });

  it("le nom dans un sous-dossier est aussi détecté", () => {
    const result = resolve(input, "packages/core/pnpm-lock.yaml", { resolveGeneratedFiles: true });
    expect(result.resolutions[0].resolutionReason).toMatch(/\[lockfile-pnpm\]/i);
  });
});
