/**
 * Regression tests for `ghCurrentUser` identity caching.
 *
 * The session-level cache must memoize a *successful* login (one request shared
 * across callers) but must NOT memoize a failure — a transient 500 (rate-limit
 * blip, momentary GitHub 5xx) once poisoned `_currentUserPromise` for the whole
 * session, so the PR panel stayed broken until the app was restarted.
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

function mockRes(opts: { ok: boolean; status?: number; body?: string; json?: unknown }) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: async () => opts.body ?? "",
    json: async () => opts.json,
  };
}

describe("ghCurrentUser caching", () => {
  beforeEach(() => {
    vi.resetModules(); // reset module-level `_currentUserPromise`
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("memoizes a successful login — a single request is shared across calls", async () => {
    devFetch.mockResolvedValue(mockRes({ ok: true, json: "alice" }));
    const { ghCurrentUser } = await import("../backend-pr");
    await expect(ghCurrentUser()).resolves.toBe("alice");
    await expect(ghCurrentUser()).resolves.toBe("alice");
    expect(devFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT memoize a failure — the next call retries and can succeed", async () => {
    devFetch
      .mockResolvedValueOnce(mockRes({ ok: false, status: 500, body: "GitHub API 403: rate limit" }))
      .mockResolvedValueOnce(mockRes({ ok: true, json: "alice" }));
    const { ghCurrentUser } = await import("../backend-pr");
    await expect(ghCurrentUser()).rejects.toThrow();
    await expect(ghCurrentUser()).resolves.toBe("alice"); // retried, not the cached rejection
    expect(devFetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server error body in the thrown message", async () => {
    devFetch.mockResolvedValue(mockRes({ ok: false, status: 500, body: "GitHub API 403: rate limit" }));
    const { ghCurrentUser } = await import("../backend-pr");
    await expect(ghCurrentUser()).rejects.toThrow(/500.*rate limit/);
  });
});
