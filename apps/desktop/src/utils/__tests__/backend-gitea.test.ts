/**
 * The read wrappers must work in browser mode (dev:web) and the write wrappers
 * must refuse it loudly, which is the split the spec fixes for this forge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../backend-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../backend-core");
  return { ...actual, isTauri: () => false, tauriInvoke: vi.fn() };
});

import { giteaListPrs, giteaMergePr } from "../backend-gitea";

describe("backend-gitea in browser mode", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ number: 1, title: "t", state: "open" }],
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a read through the dev-server", async () => {
    const prs = await giteaListPrs("/repo", "open", 10, 0);
    expect(prs).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/gitea-list-prs"),
      expect.anything(),
    );
  });

  it("refuses a write with a message that names the mode", async () => {
    await expect(giteaMergePr("/repo", 1, "merge")).rejects.toThrow(/requires Tauri/);
  });
});
