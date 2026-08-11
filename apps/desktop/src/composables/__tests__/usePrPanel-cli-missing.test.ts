/**
 * Issue #138 — Bug A: `loadPrs()`'s CLI-missing detection is forge-agnostic
 * (it matches "No such file or directory" / "ENOENT" / "program not found"
 * for any forge's CLI binary), but it always surfaced the GitHub-specific
 * `pr.error.ghNotInstalled` message ("GitHub CLI not installed — install it
 * from cli.github.com."), even when the active forge was GitLab (`glab`
 * missing) or another CLI-backed forge. This regression-tests that the
 * error message + install URL now match the active forge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// See usePrPanel.test.ts's comment on why `vi.hoisted()` is required here —
// usePrPanel.ts's import chain evaluates the mock factories before a plain
// top-level `const x = vi.fn()` in this file would have run.
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

// `forge` is derived from `forgeFromRemoteInfo(remote.value)` once `loadRemote()`
// resolves `gitRemoteInfo()`. Mocking `forgeFromRemoteInfo` directly (rather than
// relying on the real provider registry + URL sniffing) lets each test pin the
// active forge's `name` precisely.
const forgeStub = vi.hoisted(() => ({ current: { name: "github", listPRs: (..._a: unknown[]) => Promise.resolve([]) } }));
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => forgeStub.current),
  githubProvider: { name: "github", listPRs: vi.fn(async () => []) },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";

describe("usePrPanel — forge-specific CLI-missing error (issue #138)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    gitRemoteInfo.mockReset();
  });

  it("surfaces a GitHub-specific message when gh is missing on a GitHub repo", async () => {
    gitRemoteInfo.mockResolvedValue({ name: "origin", url: "https://github.com/o/r", provider: "github", owner: "o", repo: "r" });
    forgeStub.current = { name: "github", listPRs: vi.fn(async () => { throw new Error("Failed to run gh pr list (is gh installed?): No such file or directory (os error 2)"); }) };

    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    await panel.loadPrs();

    expect(panel.error.value).toContain("GitHub CLI");
    expect(panel.error.value).toContain("cli.github.com");
    expect(panel.error.value).not.toContain("GitLab");
    expect(panel.errorAction.value).toBe("open-settings");
  });

  it("surfaces a GitLab-specific message when glab is missing on a GitLab repo", async () => {
    gitRemoteInfo.mockResolvedValue({ name: "origin", url: "https://gitlab.com/o/r", provider: "gitlab", owner: "o", repo: "r" });
    forgeStub.current = { name: "gitlab", listPRs: vi.fn(async () => { throw new Error("Failed to run glab mr list (is glab installed?): No such file or directory (os error 2)"); }) };

    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    await panel.loadPrs();

    expect(panel.error.value).toContain("GitLab");
    expect(panel.error.value).not.toContain("GitHub CLI");
    expect(panel.error.value).not.toContain("cli.github.com");
    expect(panel.errorAction.value).toBe("open-settings");
  });

  // Issue #149 — a killed-on-timeout `glab`/`gh` subprocess must not be
  // misreported as "CLI not installed". `loadPrs()`'s error classification is
  // a chain of substring matches (usePrPanel.ts:605-621); a carelessly worded
  // timeout message would be silently swallowed by the CLI-missing branch.
  it("classifies a timed-out glab subprocess as a timeout, not a missing CLI", async () => {
    gitRemoteInfo.mockResolvedValue({ name: "origin", url: "https://gitlab.com/o/r", provider: "gitlab", owner: "o", repo: "r" });
    forgeStub.current = { name: "gitlab", listPRs: vi.fn(async () => { throw new Error("glab mr list failed: timed out after 20s"); }) };

    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    await panel.loadPrs();

    expect(panel.error.value).not.toContain("not installed");
    expect(panel.error.value).not.toContain("cli.github.com");
    expect(panel.error.value).toContain("GitLab");
    expect(panel.error.value).toContain("took too long to respond");
  });
});
