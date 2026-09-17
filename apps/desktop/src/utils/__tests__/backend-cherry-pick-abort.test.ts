// @vitest-environment jsdom
//
// `../backend` pulls in modules that read `window` at import time, so the
// default `node` environment cannot even load it (repo convention: opt in
// per-file — apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * gitCherryPickAbort — the dev-server branch must reject on a failed abort,
 * matching the Tauri branch (whose Rust command returns Err). See
 * docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md §3.6.
 *
 * `isTauri()` is false under vitest (no __TAURI_INTERNALS__ on globalThis), so
 * these tests exercise the dev-server branch by stubbing global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { gitCherryPickAbort } from "../backend";

function stubFetch(body: unknown) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitCherryPickAbort (dev-server branch)", () => {
  it("rejects with the server's message when the abort failed", async () => {
    stubFetch({ success: false, message: "error: no cherry-pick in progress" });

    await expect(gitCherryPickAbort("/repo")).rejects.toThrow(
      "error: no cherry-pick in progress",
    );
  });

  it("resolves when the abort succeeded", async () => {
    stubFetch({ success: true, message: "Cherry-pick aborted" });

    await expect(gitCherryPickAbort("/repo")).resolves.toBeUndefined();
  });

  it("rejects with a fallback message when the body carries none", async () => {
    stubFetch({ success: false });

    await expect(gitCherryPickAbort("/repo")).rejects.toThrow(
      "cherry-pick --abort failed",
    );
  });
});
