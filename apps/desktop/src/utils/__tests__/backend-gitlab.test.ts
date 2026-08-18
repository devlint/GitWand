/**
 * Regression test for issue #161: `glListMrs` returned the raw Tauri
 * `gl_list_mrs` payload as-is, whose fields are snake_case (`created_at`,
 * `review_requested`, `merge_state_status`, `checks_rollup`, `comment_count`)
 * straight off the Rust `PullRequest` struct — no `#[serde(rename_all =
 * "camelCase")]` on that struct, and no mapping applied here, unlike
 * `glGetMr` (detail) and every GitHub equivalent (`ghListPrs`).
 *
 * The frontend `PullRequest` type expects camelCase, so every GitLab MR row
 * in the list carried `createdAt: undefined` / `updatedAt: undefined`,
 * turning the age indicator into "NaNj" (`timeAgo(undefined)` ->
 * `new Date(undefined)` -> Invalid Date -> NaN arithmetic).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tauriInvoke = vi.fn();

vi.mock("../backend-core", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => tauriInvoke(...args),
}));

import { glListMrs, glMrPipelines, glCreateMr, glReviewerCandidates } from "../backend-gitlab";

function rawMr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 42,
    title: "Add feature",
    state: "open",
    author: "alice",
    branch: "feat/x",
    base: "main",
    draft: false,
    created_at: "2026-08-10T10:00:00Z",
    updated_at: "2026-08-15T10:00:00Z",
    url: "https://gitlab.com/x/y/-/merge_requests/42",
    additions: 5,
    deletions: 2,
    labels: ["bug"],
    assignees: ["bob"],
    review_requested: ["carol"],
    review_decision: "",
    merge_state_status: "",
    checks_rollup: "SUCCESS",
    comment_count: 3,
    ...overrides,
  };
}

describe("glListMrs", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
  });

  it("maps the raw snake_case Tauri payload to the camelCase PullRequest shape", async () => {
    tauriInvoke.mockResolvedValue([rawMr()]);
    const prs = await glListMrs("/repo", "opened", 10, 0);
    expect(prs).toHaveLength(1);
    const pr = prs[0];
    expect(pr.createdAt).toBe("2026-08-10T10:00:00Z");
    expect(pr.updatedAt).toBe("2026-08-15T10:00:00Z");
    expect(pr.reviewRequested).toEqual(["carol"]);
    expect(pr.mergeStateStatus).toBe("");
    expect(pr.checksRollup).toBe("SUCCESS");
    expect(pr.commentCount).toBe(3);
    // No snake_case leftovers on the mapped object.
    expect((pr as unknown as Record<string, unknown>).created_at).toBeUndefined();
    expect((pr as unknown as Record<string, unknown>).checks_rollup).toBeUndefined();
  });
});

describe("glMrPipelines", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
  });

  it("maps details_url to detailsUrl so the CI tab's pipeline link button can render (#161)", async () => {
    tauriInvoke.mockResolvedValue([
      { name: "Pipeline #99", state: "success", conclusion: "SUCCESS", details_url: "https://gitlab.com/x/y/-/pipelines/99" },
    ]);
    const checks = await glMrPipelines("/repo", 42);
    expect(checks).toHaveLength(1);
    expect(checks[0].detailsUrl).toBe("https://gitlab.com/x/y/-/pipelines/99");
    expect((checks[0] as unknown as Record<string, unknown>).details_url).toBeUndefined();
  });
});

describe("glCreateMr", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
  });

  it("maps the raw snake_case Tauri payload to the camelCase PullRequest shape (#161)", async () => {
    tauriInvoke.mockResolvedValue(rawMr({ number: 7 }));
    const pr = await glCreateMr("/repo", "Title", "Body", "feat/x", "main", false);
    expect(pr.number).toBe(7);
    expect(pr.createdAt).toBe("2026-08-10T10:00:00Z");
    expect(pr.checksRollup).toBe("SUCCESS");
  });
});

describe("glReviewerCandidates", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
  });

  it("maps avatar_url to avatarUrl so the reviewer picker can show avatars (#161)", async () => {
    tauriInvoke.mockResolvedValue([
      { login: "alice", name: "Alice", avatar_url: "https://gitlab.com/avatar/alice.png" },
    ]);
    const candidates = await glReviewerCandidates("/repo");
    expect(candidates).toEqual([
      { login: "alice", name: "Alice", avatarUrl: "https://gitlab.com/avatar/alice.png" },
    ]);
  });
});
