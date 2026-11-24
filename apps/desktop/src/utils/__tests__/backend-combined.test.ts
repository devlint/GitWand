/**
 * `mapRawGitDiff` (shared by `getGitShow` and `getCombinedDiff`) and the
 * `getCombinedDiff` mapping of the Rust payload: serde emits the hunk fields
 * of `GitDiff` in snake_case, the combined types in camelCase.
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

import { getCombinedDiff, getGitShow, mapRawGitDiff } from "../backend";

const RAW_DIFF = {
  path: "b.txt",
  hunks: [
    {
      header: "@@ -1 +1 @@",
      old_start: 1,
      old_count: 1,
      new_start: 1,
      new_count: 1,
      lines: [
        { type: "delete", content: "x", old_line_no: 1, new_line_no: null },
        { type: "add", content: "y", old_line_no: null, new_line_no: 1 },
      ],
    },
  ],
  status: "renamed",
  oldPath: "a.txt",
};

const MAPPED = {
  path: "b.txt",
  hunks: [
    {
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        { type: "delete", content: "x", oldLineNo: 1, newLineNo: null },
        { type: "add", content: "y", oldLineNo: null, newLineNo: 1 },
      ],
    },
  ],
  status: "renamed",
  oldPath: "a.txt",
};

beforeEach(() => {
  devFetch.mockReset();
  tauriInvoke.mockReset();
  tauri = false;
});

describe("mapRawGitDiff", () => {
  it("maps snake_case hunk fields to camelCase and keeps status/oldPath", () => {
    expect(mapRawGitDiff(RAW_DIFF)).toEqual(MAPPED);
  });

  it("keeps truncatedFromBytes", () => {
    const d = mapRawGitDiff({ path: "big", hunks: [], truncatedFromBytes: 6_000_000 });
    expect(d.truncatedFromBytes).toBe(6_000_000);
    expect(d.hunks).toEqual([]);
  });

  it("is what getGitShow returns under Tauri", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue([RAW_DIFF]);
    expect(await getGitShow("/r", "abc1234")).toEqual([MAPPED]);
  });
});

describe("getCombinedDiff", () => {
  const commit = { hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "s", author: "me", date: "2024-01-01T00:00:00Z" };

  it("maps every GitDiff of the Tauri payload", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue({
      base: null,
      commits: [commit],
      diffs: [RAW_DIFF],
      steps: [[RAW_DIFF], []],
      fallback: [
        { path: "f", conflicted: true, perCommit: [{ hash: commit.hash, diff: RAW_DIFF }], blockers: ["b".repeat(40)] },
      ],
    });
    const got = await getCombinedDiff("/r", ["aaaaaaa", "bbbbbbb"], ["f"]);
    expect(tauriInvoke).toHaveBeenCalledWith("git_combined_diff", {
      cwd: "/r",
      hashes: ["aaaaaaa", "bbbbbbb"],
      paths: ["f"],
    });
    expect(got).toEqual({
      base: null,
      commits: [commit],
      diffs: [MAPPED],
      steps: [[MAPPED], []],
      fallback: [{ path: "f", conflicted: true, perCommit: [{ hash: commit.hash, diff: MAPPED }], blockers: ["b".repeat(40)] }],
    });
  });

  it("posts to the dev-server and surfaces its error message", async () => {
    devFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Select at least 2 commits." }) });
    await expect(getCombinedDiff("/r", ["aaaaaaa"])).rejects.toThrow("Select at least 2 commits.");
    const [url, init] = devFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3001/api/git-combined-diff");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ cwd: "/r", hashes: ["aaaaaaa"] });
  });

  it("returns the dev-server payload as is", async () => {
    const payload = { base: "c".repeat(40), commits: [commit], diffs: [MAPPED], steps: [[MAPPED]], fallback: [] };
    devFetch.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    expect(await getCombinedDiff("/r", ["aaaaaaa", "bbbbbbb"])).toEqual(payload);
  });
});
