/**
 * Regression for the Launchpad quick-merge readiness gate (adversarial review
 * of PR #178, Priority 3): `openLaunchpadMergePr` (App.vue) must reflect the
 * SAME `mergeBlocked` verdict `PrDetailView` uses to disable its own merge
 * button, for the PR actually being merged — not whatever was previously
 * selected. That requires `selectPr()` (loads `prDetail`/`prReviews`) AND the
 * now-exported `loadChecks()` (loads `prChecks`) to both target the new PR
 * before `mergeBlocked` is read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrChecks = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrChecks: (...a: unknown[]) => ghPrChecks(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
  };
});

import { usePrPanel } from "../usePrPanel";

function fakeDetail(overrides: Record<string, unknown> = {}) {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "abc",
    ...overrides,
  };
}

describe("usePrPanel — Launchpad quick-merge readiness gate", () => {
  beforeEach(() => {
    ghPrDetail.mockReset();
    ghPrChecks.mockReset().mockResolvedValue([]);
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
  });

  it("blocks merge when the target PR has a failing check", async () => {
    ghPrDetail.mockResolvedValue(fakeDetail({ number: 7 }));
    ghPrChecks.mockResolvedValue([
      { name: "build", state: "COMPLETED", conclusion: "FAILURE", detailsUrl: "" },
    ]);
    ghPrListReviews.mockResolvedValue([
      { id: 1, state: "APPROVED", submitted_at: "2026-01-01", user: { login: "reviewer" } },
    ]);

    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 7 } as any);
    await p.loadChecks();

    expect(p.mergeBlocked.value).toBe(true);
    expect(p.mergeBlockedReason.value).toContain("build");
  });

  it("does not carry a stale blocked verdict over when a second, clean PR is selected on the same panel", async () => {
    ghPrDetail.mockImplementation(async (_cwd: string, number: number) =>
      fakeDetail({ number })
    );
    ghPrChecks.mockImplementation(async (_cwd: string, number: number) =>
      number === 7
        ? [{ name: "build", state: "COMPLETED", conclusion: "FAILURE", detailsUrl: "" }]
        : [{ name: "build", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "" }]
    );
    ghPrListReviews.mockResolvedValue([
      { id: 1, state: "APPROVED", submitted_at: "2026-01-01", user: { login: "reviewer" } },
    ]);

    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 7 } as any);
    await p.loadChecks();
    expect(p.mergeBlocked.value).toBe(true);

    // Simulate a second Launchpad quick-merge in the same session, on a
    // different (clean) PR — this is exactly what `openLaunchpadMergePr`
    // does on every invocation: selectPr() + loadChecks() for the PR being
    // merged right now.
    await p.selectPr({ number: 8 } as any);
    await p.loadChecks();

    expect(p.mergeBlocked.value).toBe(false);
  });
});
