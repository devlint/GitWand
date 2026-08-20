/**
 * Parity tests — `git_remote_info` (Rust) vs `/api/git-remote-info` (Node dev-server).
 *
 * Pourquoi ce fichier existe : la détection de forge depuis l'URL du remote est
 * dupliquée mot pour mot entre `detect_provider()` (Rust) et la chaîne de
 * `if/else` du dev-server. Rien ne les empêchait de divorcer — un forge ajouté
 * d'un seul côté donnait un `provider` différent selon qu'on tourne en
 * `pnpm dev` ou dans l'app buildée, donc un routage de ForgeProvider différent.
 * Ce test verrouille l'accord sur les deux bouts.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureCursorOriginRemote } from "./fixtures.mjs";

describe("parity: git-remote-info", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("remote origin.cursor.com → provider `cursor` des deux côtés", async () => {
    const cwd = fixtureCursorOriginRemote();
    await assertParity(dev, {
      command: "git-remote-info",
      args: { cwd },
      httpPath: `/api/git-remote-info?cwd=${encodeURIComponent(cwd)}`,
    });
  });
});
