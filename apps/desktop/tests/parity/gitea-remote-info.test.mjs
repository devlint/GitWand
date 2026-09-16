/**
 * Parity: Gitea detection, Rust `detect_provider` vs the dev-server chain.
 *
 * The substring chain is duplicated word for word between the two. This test
 * is what stops a forge added on one side only from producing a different
 * provider in `pnpm dev:web` than in the packaged app.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureGiteaRemote, fixtureAzureForgejoMirrorRemote } from "./fixtures.mjs";

describe("parity: gitea-remote-info", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a codeberg.org remote reads as provider `gitea` on both sides", async () => {
    const cwd = fixtureGiteaRemote();
    await assertParity(dev, {
      command: "git-remote-info",
      args: { cwd },
      httpPath: `/api/git-remote-info?cwd=${encodeURIComponent(cwd)}`,
    });
  });

  it("an Azure remote whose repo name contains \"forgejo\" still reads `azure`, not `gitea`, on both sides", async () => {
    // The gitea arm matches "gitea"/"forgejo" as a bare substring anywhere in
    // the URL, so it must be ordered after azure on both sides. This pins
    // that order rather than only the branch shape.
    const cwd = fixtureAzureForgejoMirrorRemote();
    await assertParity(dev, {
      command: "git-remote-info",
      args: { cwd },
      httpPath: `/api/git-remote-info?cwd=${encodeURIComponent(cwd)}`,
    });
  });
});
