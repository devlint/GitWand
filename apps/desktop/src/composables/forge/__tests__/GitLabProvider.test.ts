/**
 * GitLabProvider — B4 (v3.6.0): `dismissReview` is an honest unsupported
 * error (GitLab has no direct equivalent), `requestReviewers` is real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const glRequestReviewers = vi.fn();

vi.mock("../../../utils/backend", () => ({
  glRequestReviewers: (...a: unknown[]) => glRequestReviewers(...a),
}));

import { GitLabProvider } from "../GitLabProvider";
import { ForgeNotImplementedError } from "../types";

describe("GitLabProvider — review admin (B4)", () => {
  beforeEach(() => {
    glRequestReviewers.mockReset().mockResolvedValue(undefined);
  });

  it("dismissReview throws a typed ForgeNotImplementedError", () => {
    const provider = new GitLabProvider();
    expect(() => provider.dismissReview()).toThrow(ForgeNotImplementedError);
  });

  it("requestReviewers delegates to glRequestReviewers", async () => {
    const provider = new GitLabProvider();
    await provider.requestReviewers("/repo", 5, ["alice", "bob"]);
    expect(glRequestReviewers).toHaveBeenCalledWith("/repo", 5, ["alice", "bob"]);
  });
});
