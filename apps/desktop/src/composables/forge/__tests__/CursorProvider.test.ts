/**
 * CursorProvider — Cursor Origin detection-only provider (Phase 0).
 *
 * Origin is a real forge (git standard clone/push/pull works untouched), but
 * GitWand has no PR integration for it yet. The point of this provider is to
 * stop `getProviderByUrl()` from silently falling back to `githubProvider`,
 * which made an Origin repo fire `gh` CLI calls at `origin.cursor.com` and
 * surface an incomprehensible GitHub error.
 *
 * Every contract method must therefore fail with a *typed*
 * `ForgeNotImplementedError` so the PR panel can render an honest
 * "not supported yet" state instead of a raw error.
 */
import { describe, it, expect } from "vitest";
import { CursorProvider } from "../CursorProvider";
import { ForgeNotImplementedError, type ForgeProvider } from "../types";

describe("CursorProvider — remote detection", () => {
  const provider = new CursorProvider();

  it("is named `cursor`", () => {
    expect(provider.name).toBe("cursor");
  });

  it("claims Origin's git host over HTTPS and SSH", () => {
    expect(provider.detectFromRemote("https://origin.cursor.com/acme/checkout.git")).toBe(true);
    expect(provider.detectFromRemote("git@origin.cursor.com:acme/checkout.git")).toBe(true);
  });

  it("does not claim the Cursor web UI or unrelated forges", () => {
    // `cursor.com/codebase/...` is the web UI, never a git remote.
    expect(provider.detectFromRemote("https://cursor.com/codebase/acme/checkout")).toBe(false);
    expect(provider.detectFromRemote("https://github.com/acme/checkout.git")).toBe(false);
    expect(provider.detectFromRemote("git@gitlab.com:acme/checkout.git")).toBe(false);
  });
});

describe("CursorProvider — every contract method is an honest unsupported error", () => {
  const provider = new CursorProvider();

  // One entry per *required* ForgeProvider method, with a minimal valid call.
  const calls: Array<[string, () => unknown]> = [
    ["getCurrentUser", () => provider.getCurrentUser("/repo")],
    ["listReviewerCandidates", () => provider.listReviewerCandidates("/repo")],
    ["listPRs", () => provider.listPRs("/repo", { state: "open" })],
    ["getPRCount", () => provider.getPRCount("/repo", "open")],
    ["getPRFiles", () => provider.getPRFiles("/repo", 1)],
    ["getPR", () => provider.getPR("/repo", 1)],
    ["getPRDiff", () => provider.getPRDiff("/repo", 1)],
    ["getCIChecks", () => provider.getCIChecks("/repo", 1)],
    ["getCheckAnnotations", () => provider.getCheckAnnotations("/repo", 1)],
    ["createPR", () => provider.createPR("/repo", { title: "t", body: "b" })],
    ["mergePR", () => provider.mergePR("/repo", 1)],
    ["checkoutPR", () => provider.checkoutPR("/repo", 1)],
    ["convertDraftToReady", () => provider.convertDraftToReady("/repo", 1)],
    ["listComments", () => provider.listComments("/repo", 1)],
    ["createComment", () => provider.createComment("/repo", 1, { body: "x" } as never)],
    ["updateComment", () => provider.updateComment("/repo", 1, "x")],
    ["deleteComment", () => provider.deleteComment("/repo", 1)],
    ["listReviews", () => provider.listReviews("/repo", 1)],
    ["submitReview", () => provider.submitReview("/repo", 1, { event: "COMMENT" })],
    ["getConflictPreview", () => provider.getConflictPreview("/repo", 1)],
    ["getHotspots", () => provider.getHotspots("/repo", ["a.ts"])],
    ["getFileHistory", () => provider.getFileHistory("/repo", ["a.ts"])],
  ];

  for (const [method, call] of calls) {
    it(`${method}() throws a typed ForgeNotImplementedError`, () => {
      expect(call).toThrow(ForgeNotImplementedError);
      try {
        call();
      } catch (err: any) {
        expect(err.name).toBe("ForgeNotImplementedError");
        expect(err.message).toContain("cursor");
        expect(err.message).toContain(method);
      }
    });
  }

  it("setAccount is a no-op rather than a throw", () => {
    // Called unconditionally by the account-aware resolution path in useForge;
    // throwing here would break repo switching, not just the PR panel.
    expect(() => provider.setAccount(null)).not.toThrow();
  });

  it("omits the optional methods entirely so callers hide those affordances", () => {
    // The contract's "unsupported hides the action" path checks for absence, so
    // probe through the interface type rather than the concrete class.
    const contract: ForgeProvider = provider;
    expect(contract.listIssues).toBeUndefined();
    expect(contract.listBranches).toBeUndefined();
    expect(contract.dismissReview).toBeUndefined();
    expect(contract.requestReviewers).toBeUndefined();
  });
});
