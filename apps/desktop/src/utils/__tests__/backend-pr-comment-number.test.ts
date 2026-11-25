/**
 * #262 — on a fork, the dev-server finds a review comment's repo from the PR
 * number, as the desktop commands do (`get_pr_json`): the edit and delete
 * routes must receive it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const devFetch = vi.fn();

vi.mock("../backend-core", () => ({
  isTauri: () => false,
  devFetch: (...args: unknown[]) => devFetch(...args),
  tauriInvoke: vi.fn(),
  DEV_SERVER: "http://localhost:3001",
  IPC_TIMEOUT: {},
}));

describe("review comment edit/delete send the PR number", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    devFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  it("ghPrUpdateComment sends it in the body", async () => {
    const { ghPrUpdateComment } = await import("../backend-pr");
    await ghPrUpdateComment("/repo", 42, "new text", 7);
    const [url, init] = devFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3001/api/gh-pr-comment?id=42");
    expect(JSON.parse(init.body)).toEqual({ cwd: "/repo", body: "new text", number: 7 });
  });

  it("ghPrDeleteComment sends it in the query", async () => {
    const { ghPrDeleteComment } = await import("../backend-pr");
    await ghPrDeleteComment("/repo", 42, 7);
    expect(devFetch.mock.calls[0][0]).toBe(
      "http://localhost:3001/api/gh-pr-comment?cwd=%2Frepo&id=42&number=7",
    );
  });
});
