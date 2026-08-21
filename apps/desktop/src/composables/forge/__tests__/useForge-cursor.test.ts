/**
 * Forge registry routing for Cursor Origin.
 *
 * `getProviderByName()` ends in `?? githubProvider`, so an unregistered forge
 * name is not an error — it silently becomes GitHub. That is exactly the bug
 * Phase 0 fixes: an Origin repo used to route to `githubProvider` and fire
 * `gh` CLI calls at `origin.cursor.com`.
 *
 * The non-GitHub providers are pre-warmed via `import().then()` at module init,
 * hence the awaited tick before asserting.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("../../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(),
}));

import { getProviderByName, getProviderByUrl, forgeFromRemoteInfo } from "../useForge";

describe("forge registry — Cursor Origin routing", () => {
  beforeAll(async () => {
    // The pre-warm is `import().then()` at module init, so the registry is
    // empty for the first few microtasks. Wait on a known-registered forge
    // rather than a bare timeout, which raced.
    await vi.waitFor(() => {
      expect(getProviderByName("gitlab").name).toBe("gitlab");
      expect(getProviderByName("azure").name).toBe("azure");
    });
  });

  it("routes the `cursor` provider name to CursorProvider, not GitHub", () => {
    expect(getProviderByName("cursor").name).toBe("cursor");
  });

  it("routes an origin.cursor.com remote URL to CursorProvider", () => {
    expect(getProviderByUrl("https://origin.cursor.com/acme/checkout.git").name).toBe("cursor");
  });

  it("routes a RemoteInfo carrying provider=cursor to CursorProvider", () => {
    expect(
      forgeFromRemoteInfo({
        provider: "cursor",
        url: "https://origin.cursor.com/acme/checkout.git",
      }).name
    ).toBe("cursor");
  });

  it("still routes the pre-existing forges correctly", () => {
    expect(getProviderByName("github").name).toBe("github");
    expect(getProviderByName("gitlab").name).toBe("gitlab");
    expect(getProviderByName("bitbucket").name).toBe("bitbucket");
    expect(getProviderByName("azure").name).toBe("azure");
  });
});
