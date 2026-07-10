/**
 * `PullRequestDetail.headSha` mapping (Task 0, v3.6.0) — viewed-state
 * invalidation (B2) and AI findings/summary caching (C3/D1) key off this
 * field, so a missing/renamed backend field must fail loudly here rather
 * than silently degrade to `""` everywhere.
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

function mockRes(json: unknown) {
  return { ok: true, status: 200, text: async () => "", json: async () => json };
}

const RAW_DETAIL = {
  number: 42,
  title: "t",
  body: "b",
  state: "open",
  author: "alice",
  branch: "feat",
  base: "main",
  draft: false,
  created_at: "2026-01-01",
  updated_at: "2026-01-02",
  merged_at: "",
  url: "https://example.com/42",
  additions: 1,
  deletions: 1,
  changed_files: 1,
  comments: 0,
  review_comments: 0,
  labels: [],
  reviewers: [],
  mergeable: "MERGEABLE",
  checks_status: "success",
  can_merge: true,
};

describe("ghPrDetail — headSha mapping", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("maps dev-server head_sha to headSha", async () => {
    devFetch.mockResolvedValue(mockRes({ ...RAW_DETAIL, head_sha: "abc123" }));
    const { ghPrDetail } = await import("../backend-pr");
    const detail = await ghPrDetail("/repo", 42);
    expect(detail.headSha).toBe("abc123");
  });

  it("falls back to empty string when head_sha is missing", async () => {
    devFetch.mockResolvedValue(mockRes({ ...RAW_DETAIL }));
    const { ghPrDetail } = await import("../backend-pr");
    const detail = await ghPrDetail("/repo", 42);
    expect(detail.headSha).toBe("");
  });

  it("maps the Tauri head_sha the same way", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue({ ...RAW_DETAIL, head_sha: "def456" });
    const { ghPrDetail } = await import("../backend-pr");
    const detail = await ghPrDetail("/repo", 42);
    expect(detail.headSha).toBe("def456");
  });
});
