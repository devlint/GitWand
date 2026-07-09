/**
 * Task B4 (v3.6.0) — `ghDismissReview`/`ghRequestReviewers` dev-server
 * wrapper shape (parity with the Rust Tauri commands).
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
}));

function mockRes(opts: { ok: boolean; json?: unknown }) {
  return { ok: opts.ok, status: opts.ok ? 200 : 500, json: async () => opts.json ?? {} };
}

describe("ghDismissReview / ghRequestReviewers", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("ghDismissReview posts to the dev-server route with { ok: true }", async () => {
    devFetch.mockResolvedValue(mockRes({ ok: true, json: { ok: true } }));
    const { ghDismissReview } = await import("../backend-pr");
    await expect(ghDismissReview("/repo", 1, 7, "resolved")).resolves.toBeUndefined();
    expect(devFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/gh-dismiss-review",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ghDismissReview surfaces the server error", async () => {
    devFetch.mockResolvedValue(mockRes({ ok: false, json: { error: "not found" } }));
    const { ghDismissReview } = await import("../backend-pr");
    await expect(ghDismissReview("/repo", 1, 7)).rejects.toThrow(/not found/);
  });

  it("ghRequestReviewers posts logins to the dev-server route", async () => {
    devFetch.mockResolvedValue(mockRes({ ok: true, json: { ok: true } }));
    const { ghRequestReviewers } = await import("../backend-pr");
    await expect(ghRequestReviewers("/repo", 1, ["alice"])).resolves.toBeUndefined();
    const [, init] = devFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ cwd: "/repo", number: 1, logins: ["alice"] });
  });

  it("ghDismissReview routes through tauriInvoke in Tauri", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue(undefined);
    const { ghDismissReview } = await import("../backend-pr");
    await ghDismissReview("/repo", 1, 7, "msg");
    expect(tauriInvoke).toHaveBeenCalledWith("gh_dismiss_review", {
      cwd: "/repo", number: 1, reviewId: 7, message: "msg",
    });
  });
});
