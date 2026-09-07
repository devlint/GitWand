/**
 * Parity tests — `git_status` (Rust) vs `/api/git-status` (Node dev-server).
 *
 * Run : `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prérequis : avoir compilé le probe Rust au moins une fois
 *   cargo build --example parity-probe
 * (cf. README.md dans ce dossier).
 *
 * Portée :
 *  - fixture clean  → section `branch` + arbre vide partout
 *  - fixture dirty  → staged + unstaged + untracked non-triviaux
 *
 * Les deux backends sont interrogés sur le *même* repo temporaire déterministe.
 * On s'attend à une égalité structurelle après normalisation (camelCase).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureClean, fixtureDirty } from "./fixtures.mjs";

describe("parity: git-status", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("fixtureClean → arbre propre, branch main, pas de fichiers", async () => {
    const cwd = fixtureClean();
    await assertParity(dev, {
      command: "git-status",
      args: { cwd },
      httpPath: `/api/git-status?cwd=${encodeURIComponent(cwd)}`,
    });
  });

  it("fixtureDirty → staged + unstaged + untracked cohabitent", async () => {
    const cwd = fixtureDirty();
    const { rust, node } = await assertParity(dev, {
      command: "git-status",
      args: { cwd },
      httpPath: `/api/git-status?cwd=${encodeURIComponent(cwd)}`,
    });

    // Issue #181 : un dossier jamais stagé doit remonter fichier par fichier,
    // et non comme une entrée `newdir/` unique. La parité seule ne suffit pas
    // ici : les deux backends pourraient être d'accord et tous les deux faux.
    for (const side of [rust, node]) {
      expect(side.untracked).toContain("newdir/e.txt");
      expect(side.untracked).toContain("newdir/sub/f.txt");
      expect(side.untracked).not.toContain("newdir/");
    }
  });
});
