/**
 * Cursor Origin (Phase 0) — a forge GitWand detects but has no PR integration
 * for must produce an honest, actionable banner.
 *
 * `loadPrs()` classifies failures through a chain of substring matches. A
 * typed `ForgeNotImplementedError` fell through that whole chain to the final
 * `else`, which dumps the raw message — users would read
 * "[ForgeProvider:cursor] listPRs() not yet implemented". Worse, the chain's
 * first branch (CLI-missing) is loose enough that a differently-worded error
 * could be misreported as "install the GitHub CLI", which would be actively
 * wrong: no CLI install fixes this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const { listPRs, gitRemoteInfo } = vi.hoisted(() => ({
  listPRs: vi.fn(),
  gitRemoteInfo: vi.fn(),
}));

vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: (...args: unknown[]) => gitRemoteInfo(...args),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
  ghPrFreshnessSignal: vi.fn(),
  detectClaudeCli: vi.fn(async () => ({
    found: false, path: "", version: "", logged_in: false, status: "not_found",
  })),
}));

const forgeStub = vi.hoisted(() => ({
  current: { name: "github", listPRs: (..._a: unknown[]) => Promise.resolve([]) },
}));
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => forgeStub.current),
  githubProvider: { name: "github", listPRs: vi.fn(async () => []) },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";
import { ForgeNotImplementedError } from "../forge/types";

describe("usePrPanel — forge detected but PR-unsupported (Cursor Origin)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    gitRemoteInfo.mockReset();
  });

  /** Wires a Cursor Origin repo whose provider throws the typed error. */
  async function cursorPanel() {
    gitRemoteInfo.mockResolvedValue({
      name: "origin",
      url: "https://origin.cursor.com/acme/checkout.git",
      provider: "cursor",
      owner: "acme",
      repo: "checkout",
    });
    forgeStub.current = {
      name: "cursor",
      listPRs: vi.fn(async () => {
        throw new ForgeNotImplementedError("cursor", "listPRs");
      }),
    };
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    await panel.loadPrs();
    return panel;
  }

  it("names the forge instead of leaking the internal error", async () => {
    const panel = await cursorPanel();
    expect(panel.error.value).toContain("Cursor Origin");
    expect(panel.error.value).not.toContain("ForgeProvider");
    expect(panel.error.value).not.toContain("listPRs");
  });

  it("never blames a missing CLI, which no install would fix", async () => {
    const panel = await cursorPanel();
    expect(panel.error.value).not.toContain("CLI");
    expect(panel.error.value).not.toContain("cli.github.com");
    expect(panel.errorAction.value).not.toBe("open-settings");
  });

  it("offers the web UI as the way out", async () => {
    const panel = await cursorPanel();
    expect(panel.errorAction.value).toBe("open-forge-web");
  });

  it("targets the repo's Origin web page, built from the remote's owner/repo", async () => {
    const panel = await cursorPanel();
    expect(panel.forgeWebUrl.value).toBe("https://cursor.com/codebase/acme/checkout");
  });

  it("offers no web URL on a forge that has a working PR integration", async () => {
    gitRemoteInfo.mockResolvedValue({
      name: "origin", url: "https://github.com/o/r", provider: "github", owner: "o", repo: "r",
    });
    forgeStub.current = { name: "github", listPRs: vi.fn(async () => []) };
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();

    expect(panel.forgeWebUrl.value).toBeNull();
  });

  it("reports the forge as PR-unsupported so the UI can hide affordances", async () => {
    // Driven off the provider, NOT off an error having already happened: the
    // "New PR" button must be gone on first paint, before any failed listPRs.
    gitRemoteInfo.mockResolvedValue({
      name: "origin",
      url: "https://origin.cursor.com/acme/checkout.git",
      provider: "cursor",
      owner: "acme",
      repo: "checkout",
    });
    forgeStub.current = { name: "cursor", listPRs: vi.fn(async () => []) };
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();

    expect(panel.prSupported.value).toBe(false);
  });

  it("reports a working forge as PR-supported", async () => {
    gitRemoteInfo.mockResolvedValue({
      name: "origin", url: "https://github.com/o/r", provider: "github", owner: "o", repo: "r",
    });
    forgeStub.current = { name: "github", listPRs: vi.fn(async () => []) };
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();

    expect(panel.prSupported.value).toBe(true);
  });

  it("leaves an ordinary GitHub failure classified as before", async () => {
    gitRemoteInfo.mockResolvedValue({
      name: "origin", url: "https://github.com/o/r", provider: "github", owner: "o", repo: "r",
    });
    forgeStub.current = {
      name: "github",
      listPRs: vi.fn(async () => {
        throw new Error("Failed to run gh pr list (is gh installed?): No such file or directory (os error 2)");
      }),
    };
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    await panel.loadPrs();

    expect(panel.error.value).toContain("GitHub CLI");
    expect(panel.errorAction.value).toBe("open-settings");
  });
});
