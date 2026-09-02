/**
 * `gitMerge` — no-fast-forward option (#177).
 *
 * Locks in that the `noFf` flag is forwarded to both the Tauri IPC call
 * and the dev-server HTTP body, and defaults to false when omitted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const devFetch = vi.fn();
const tauriInvoke = vi.fn();
let tauri = false;

vi.mock("../backend-core", () => ({
  isTauri: () => tauri,
  devFetch: (...args: unknown[]) => devFetch(...args),
  tauriInvoke: (...args: unknown[]) => tauriInvoke(...args),
  DEV_SERVER: "http://localhost:3001",
  IPC_TIMEOUT: { NETWORK: 30000, DEFAULT: 10000 },
  devTerminalOpen: vi.fn(),
}));

function mockRes(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

describe("gitMerge", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("forwards noFf=true to the Tauri IPC call", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue({ success: true, message: "done" });
    const { gitMerge } = await import("../backend");

    await gitMerge("/repo", "feature", true);

    expect(tauriInvoke).toHaveBeenCalledWith("git_merge", { cwd: "/repo", branch: "feature", noFf: true });
  });

  it("defaults noFf to false when omitted, over dev-server HTTP", async () => {
    tauri = false;
    devFetch.mockResolvedValue(mockRes({ success: true, message: "done" }));
    const { gitMerge } = await import("../backend");

    await gitMerge("/repo", "feature");

    expect(devFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/git-merge"),
      expect.objectContaining({
        body: JSON.stringify({ cwd: "/repo", branch: "feature", noFf: false }),
      }),
    );
  });
});
