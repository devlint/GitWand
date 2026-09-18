// @vitest-environment jsdom
//
// `../backend` reads `window` at import time, so the default `node`
// environment cannot load it (apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * gitOperationAction — the dev-server branch. Three outcomes, not two
 * (docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md §3):
 * a halt on a further conflict resolves, only a real failure rejects.
 *
 * `isTauri()` is false under vitest, so these exercise the dev-server branch
 * by stubbing global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { gitOperationAction } from "../backend";

function stubFetch(body: unknown, ok = true, status = 200) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitOperationAction (dev-server branch)", () => {
  it("resolves with halted false when the operation completed", async () => {
    stubFetch({ halted: false });

    await expect(
      gitOperationAction("/repo", "merge", "continue"),
    ).resolves.toEqual({ halted: false });
  });

  it("resolves with halted true when git stopped on a further conflict", async () => {
    // Progress, not failure — the whole point of the model.
    stubFetch({ halted: true });

    await expect(
      gitOperationAction("/repo", "cherry_pick", "continue"),
    ).resolves.toEqual({ halted: true });
  });

  it("rejects with the server's message when git refused", async () => {
    stubFetch(
      { error: "git merge --abort failed: fatal: There is no merge to abort" },
      false,
      500,
    );

    await expect(gitOperationAction("/repo", "merge", "abort")).rejects.toThrow(
      "There is no merge to abort",
    );
  });

  it("rejects with a fallback message when the body carries none", async () => {
    stubFetch({}, false, 500);

    await expect(gitOperationAction("/repo", "merge", "abort")).rejects.toThrow(
      "operation action failed",
    );
  });

  it("sends the operation and action in the body", async () => {
    const spy = stubFetch({ halted: false });

    await gitOperationAction("/repo", "revert", "skip");

    const body = JSON.parse(spy.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ cwd: "/repo", operation: "revert", action: "skip" });
  });
});
