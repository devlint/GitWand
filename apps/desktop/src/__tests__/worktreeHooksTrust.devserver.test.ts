/**
 * v3.13 — The dev-server mirror of `worktree_trust.rs` must hash exactly like
 * the Rust backend, or manual QA in `dev:web` would trust what the app asks
 * about again. The vector is shared with `hooks_hash_test_vector` in Rust.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module without types, shared with dev-server.mjs
import { devHooksHash, devHooksFromRcText } from "../../dev-worktree-trust.mjs";

describe("dev-server worktree hook trust", () => {
  it("matches the Rust hash test vector", () => {
    expect(devHooksHash({ setup: 'a "q"\nb', teardown: null, url: "é" })).toBe(
      "a9f492b9688f1a51668dd0d1224ace3f39822e1f61779ebd50051b34591d09f7",
    );
  });

  it("returns null when there is nothing to trust", () => {
    expect(devHooksHash({ setup: null, teardown: null, url: null })).toBeNull();
  });

  it("drops blank and non-string hooks like the backend", () => {
    expect(devHooksFromRcText('{"worktree":{"setup":"bin/up","teardown":" ","url":3}}')).toEqual({
      setup: "bin/up",
      teardown: null,
      url: null,
    });
    expect(devHooksFromRcText("not json")).toEqual({ setup: null, teardown: null, url: null });
  });
});
