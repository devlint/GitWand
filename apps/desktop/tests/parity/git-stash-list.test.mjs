/**
 * Parity tests — `git_stash_list` (Rust) vs `/api/git-stash-list` (Node dev-server).
 *
 * #151: `date` used to be blanked by normalize.mjs before comparison, which hid
 * the fact that Rust emitted git's lenient `%ai` ("2024-01-01 00:00:02 +0000",
 * unparseable by JavaScriptCore → "Invalid Date" in the shipped webview) while
 * the dev-server emitted `%ct` + toISOString(). Both sides now pass `%aI`
 * straight through, so `date` is compared like every other field.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureStash } from "./fixtures.mjs";

/** `%aI` emits a bare `Z` for UTC commits, `±HH:MM` otherwise. */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

describe("parity: git-stash-list", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("fixtureStash → 2 stashes avec hash, index, message ET date", async () => {
    const cwd = fixtureStash();
    const { rust, node } = await assertParity(dev, {
      command: "git-stash-list",
      args: { cwd },
      httpPath: `/api/git-stash-list?cwd=${encodeURIComponent(cwd)}`,
    });

    expect(rust).toHaveLength(2);
    for (const entry of [...rust, ...node]) {
      // Shape: strictly parseable by `new Date()` in every JS engine.
      expect(entry.date).toMatch(STRICT_ISO);
      // Value: fixtureStash anchors the stash commits at 2024-01-01T00:00:0Xs.
      expect(new Date(entry.date).getTime()).not.toBeNaN();
      expect(entry.date.startsWith("2024-01-01T00:00:0")).toBe(true);
    }
  });
});
