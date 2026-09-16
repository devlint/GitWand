/**
 * GiteaProvider: the implemented surface delegates to the backend wrappers,
 * and the unimplemented surface throws ForgeNotImplementedError so the UI
 * hides the affordance instead of showing a button that does nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const giteaCurrentUser = vi.fn();
const giteaListPrs = vi.fn();
const giteaGetPr = vi.fn();
const giteaPrDiff = vi.fn();
const giteaPrStatus = vi.fn();
const giteaPrComments = vi.fn();
const giteaCreateComment = vi.fn();
const giteaListReviews = vi.fn();
const giteaMergePr = vi.fn();
const giteaListIssues = vi.fn();

vi.mock("../../../utils/backend", () => ({
  giteaCurrentUser: (...a: unknown[]) => giteaCurrentUser(...a),
  giteaListPrs: (...a: unknown[]) => giteaListPrs(...a),
  giteaGetPr: (...a: unknown[]) => giteaGetPr(...a),
  giteaPrDiff: (...a: unknown[]) => giteaPrDiff(...a),
  giteaPrStatus: (...a: unknown[]) => giteaPrStatus(...a),
  giteaPrComments: (...a: unknown[]) => giteaPrComments(...a),
  giteaCreateComment: (...a: unknown[]) => giteaCreateComment(...a),
  giteaListReviews: (...a: unknown[]) => giteaListReviews(...a),
  giteaMergePr: (...a: unknown[]) => giteaMergePr(...a),
  giteaListIssues: (...a: unknown[]) => giteaListIssues(...a),
  giteaPrCount: vi.fn(),
  giteaPrFiles: vi.fn(),
  giteaCreatePr: vi.fn(),
  giteaCheckoutPr: vi.fn(),
  giteaConvertDraftToReady: vi.fn(),
  giteaUpdateComment: vi.fn(),
  giteaDeleteComment: vi.fn(),
  giteaReviewerCandidates: vi.fn(),
  giteaBranches: vi.fn(),
  ghPrConflictPreview: vi.fn(),
  ghPrHotspots: vi.fn(),
}));

import { GiteaProvider } from "../GiteaProvider";
import { ForgeNotImplementedError, type ForgeProvider } from "../types";

describe("GiteaProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports its forge name", () => {
    expect(new GiteaProvider().name).toBe("gitea");
  });

  it("detects the hosts the pure Rust arm also detects", () => {
    const p = new GiteaProvider();
    expect(p.detectFromRemote("https://codeberg.org/acme/app.git")).toBe(true);
    expect(p.detectFromRemote("git@gitea.acme.io:acme/app.git")).toBe(true);
    expect(p.detectFromRemote("https://forgejo.acme.io/acme/app.git")).toBe(true);
    expect(p.detectFromRemote("https://github.com/acme/app.git")).toBe(false);
  });

  it("delegates listPRs with the state it was given", async () => {
    giteaListPrs.mockResolvedValue([]);
    await new GiteaProvider().listPRs("/repo", { state: "open", limit: 25, offset: 0 });
    expect(giteaListPrs).toHaveBeenCalledWith("/repo", "open", 25, 0);
  });

  it("delegates getPR, getPRDiff and getCIChecks", async () => {
    giteaGetPr.mockResolvedValue({ number: 1 });
    giteaPrDiff.mockResolvedValue("diff");
    giteaPrStatus.mockResolvedValue([]);
    const p = new GiteaProvider();
    await p.getPR("/repo", 1);
    await p.getPRDiff("/repo", 1);
    await p.getCIChecks("/repo", 1);
    expect(giteaGetPr).toHaveBeenCalledWith("/repo", 1);
    expect(giteaPrDiff).toHaveBeenCalledWith("/repo", 1);
    expect(giteaPrStatus).toHaveBeenCalledWith("/repo", 1);
  });

  it("returns no check annotations rather than failing", async () => {
    await expect(new GiteaProvider().getCheckAnnotations("/repo", 1)).resolves.toEqual([]);
  });

  it("throws ForgeNotImplementedError for auto-merge", async () => {
    const p = new GiteaProvider();
    await expect(p.enableAutoMerge("/repo", 1)).rejects.toBeInstanceOf(ForgeNotImplementedError);
    await expect(p.disableAutoMerge("/repo", 1)).rejects.toBeInstanceOf(ForgeNotImplementedError);
  });

  it("omits dismissReview entirely so the capability check hides the action", () => {
    // Defined-but-throwing would pass `typeof forge.dismissReview === "function"`
    // and render a button that silently fails. Same reasoning as GitLab.
    const p: ForgeProvider = new GiteaProvider();
    expect(p.dismissReview).toBeUndefined();
  });

  it("throws ForgeNotImplementedError from submitReview", async () => {
    await expect(
      new GiteaProvider().submitReview("/repo", 1, { event: "APPROVE" }),
    ).rejects.toBeInstanceOf(ForgeNotImplementedError);
  });

  it("returns an empty file history rather than inventing one", async () => {
    await expect(new GiteaProvider().getFileHistory("/repo", ["a.ts"])).resolves.toEqual({});
  });
});
