/**
 * dev-server branch PR lookup (v3.14.0, stacked branches): the rules of
 * `parse_gh_branch_pr_json` and `fork_parent_nwo` in `commands/gh.rs`, ported
 * from its `branch_pr_tests` over the same canned `gh` JSON, so `pnpm dev:web`
 * finds the same PR the Tauri build does.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no type declarations
import { devParseGhBranchPr, devForkParentNwo } from "../../dev-gh-branch-pr.mjs";

describe("devParseGhBranchPr", () => {
  it("keeps the newest merge", () => {
    const s = `[{"number":800,"baseRefName":"main","headRefOid":"aaa","mergedAt":"2026-11-01T00:00:00Z","url":"u1","headRepositoryOwner":{"login":"o"}},
                {"number":812,"baseRefName":"main","headRefOid":"bbb","mergedAt":"2026-11-20T00:00:00Z","url":"u2","headRepositoryOwner":{"login":"o"}}]`;
    expect(devParseGhBranchPr(s, "merged", "o")).toEqual({
      number: 812,
      base: "main",
      head_ref_oid: "bbb",
      merged_at: "2026-11-20T00:00:00Z",
      url: "u2",
    });
  });

  it("filters to the origin owner, case-insensitively, before choosing", () => {
    const s = `[{"number":1,"baseRefName":"main","headRefOid":"a","mergedAt":"2026-11-25T00:00:00Z","url":"u1","headRepositoryOwner":{"login":"alice"}},
                {"number":2,"baseRefName":"main","headRefOid":"b","mergedAt":"2026-11-01T00:00:00Z","url":"u2","headRepositoryOwner":{"login":"Bob"}},
                {"number":3,"baseRefName":"main","headRefOid":"c","mergedAt":"2026-11-30T00:00:00Z","url":"u3"},
                {"number":4,"baseRefName":"main","headRefOid":"d","mergedAt":"2026-11-30T00:00:00Z","url":"u4","headRepositoryOwner":{"login":""}}]`;
    expect(devParseGhBranchPr(s, "merged", "bob").number).toBe(2);
    expect(devParseGhBranchPr(s, "merged", "carol")).toBe(null);
    // Ownerless entries are dropped even when the origin owner is empty.
    expect(devParseGhBranchPr(s, "merged", "")).toBe(null);
  });

  it("never falls back to an unmerged PR for a merged lookup", () => {
    const nullDate = `[{"number":9,"baseRefName":"m","headRefOid":"c","mergedAt":null,"url":"u","headRepositoryOwner":{"login":"o"}}]`;
    const missing = `[{"number":9,"baseRefName":"m","headRefOid":"c","url":"u","headRepositoryOwner":{"login":"o"}}]`;
    expect(devParseGhBranchPr(nullDate, "merged", "o")).toBe(null);
    expect(devParseGhBranchPr(missing, "merged", "o")).toBe(null);
    expect(devParseGhBranchPr(nullDate, "open", "o").number).toBe(9);
  });

  it("an open PR has no merge date; the first one wins", () => {
    const s = `[{"number":9,"baseRefName":"step-1","headRefOid":"c","mergedAt":null,"url":"u","headRepositoryOwner":{"login":"o"}},
                {"number":10,"baseRefName":"main","headRefOid":"d","mergedAt":null,"url":"u","headRepositoryOwner":{"login":"o"}}]`;
    const pr = devParseGhBranchPr(s, "open", "o");
    expect([pr.number, pr.base, pr.merged_at]).toEqual([9, "step-1", null]);
  });

  it("an empty list is null; a non-list or bad JSON is an error", () => {
    expect(devParseGhBranchPr("[]", "open", "o")).toBe(null);
    expect(() => devParseGhBranchPr("{}", "open", "o")).toThrow("gh pr list did not return a list");
    expect(() => devParseGhBranchPr("nope", "open", "o")).toThrow(/^Failed to parse gh pr list output: /);
  });

  it("of equal merge dates, the last one wins, as Rust's max_by", () => {
    const s = `[{"number":1,"baseRefName":"m","headRefOid":"a","mergedAt":"2026-11-01T00:00:00Z","url":"u","headRepositoryOwner":{"login":"o"}},
                {"number":2,"baseRefName":"m","headRefOid":"b","mergedAt":"2026-11-01T00:00:00Z","url":"u","headRepositoryOwner":{"login":"o"}}]`;
    expect(devParseGhBranchPr(s, "merged", "o").number).toBe(2);
  });
});

describe("devForkParentNwo", () => {
  it("is the parent of a fork, null otherwise", () => {
    expect(devForkParentNwo({ isFork: true, parent: { owner: { login: "org" }, name: "app" } })).toBe("org/app");
    expect(devForkParentNwo({ isFork: false, parent: { owner: { login: "org" }, name: "app" } })).toBe(null);
    expect(devForkParentNwo({ isFork: true, parent: { owner: { login: "" }, name: "app" } })).toBe(null);
    expect(devForkParentNwo({ isFork: true })).toBe(null);
  });
});
