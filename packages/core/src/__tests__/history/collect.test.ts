import { describe, it, expect, afterEach } from "vitest";
import { collectHunkHistory, createHistoryCache, HistoryTimeout } from "../../history/collect.js";
import { parseConflictMarkers } from "../../parser.js";
import type { GitRunner, HistoryRefs } from "../../history/types.js";
import { makeRepo, type Repo } from "../utils/git-repo.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let repo: Repo;
afterEach(() => repo?.cleanup());

const lines = (...l: string[]) => l.join("\n") + "\n";

function firstHunk(r: Repo, path: string) {
  const content = readFileSync(join(r.dir, path), "utf-8");
  const seg = parseConflictMarkers(content).segments.find((s) => s.type === "conflict");
  if (!seg || seg.type !== "conflict") throw new Error("no conflict");
  return seg.conflict;
}

function refs(r: Repo, operation: HistoryRefs["operation"], head: string): HistoryRefs {
  return {
    operation,
    oursSha: r.git(["rev-parse", "HEAD"]).trim(),
    theirsSha: r.git(["rev-parse", head]).trim(),
  };
}

/** base → side branch edits line 3 → main edits line 3 differently → merge conflicts. */
function mergeConflict(r: Repo) {
  r.write("f.txt", lines("a", "b", "c", "d", "e"));
  r.git(["add", "."]);
  r.git(["commit", "-qm", "base"]);
  r.git(["switch", "-qc", "side"]);
  r.write("f.txt", lines("a", "b", "C-theirs", "d", "e"));
  r.git(["commit", "-qam", "theirs: shout c", "-m", "because theirs wants it loud"]);
  r.git(["switch", "-q", "main"]);
  r.write("f.txt", lines("a", "b", "c-ours", "d", "e"));
  r.git(["commit", "-qam", "ours: suffix c"]);
}

describe("collectHunkHistory — merge", () => {
  it("returns each side's commits since the merge base, with range diffs", async () => {
    repo = makeRepo();
    mergeConflict(repo);
    repo.git(["merge", "side"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");

    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "merge", "MERGE_HEAD") });

    expect(h.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(h.ours.status).toBe("ok");
    expect(h.ours.commits.map((c) => c.subject)).toEqual(["ours: suffix c"]);
    expect(h.ours.commits[0].rangeDiff).toContain("+c-ours");
    expect(h.theirs.commits.map((c) => c.subject)).toEqual(["theirs: shout c"]);
    expect(h.theirs.commits[0].body).toBe("because theirs wants it loud");
    // Nothing from before the merge base.
    expect([...h.ours.commits, ...h.theirs.commits].some((c) => c.subject === "base")).toBe(false);
  });

  it("reuses the per-file cache across hunks", async () => {
    repo = makeRepo();
    mergeConflict(repo);
    repo.git(["merge", "side"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    const calls: string[][] = [];
    const counting: GitRunner = (args) => { calls.push(args); return repo.runner(args); };
    const cache = createHistoryCache();
    const input = { filePath: "f.txt", hunk, refs: refs(repo, "merge", "MERGE_HEAD"), cache };
    await collectHunkHistory(counting, input);
    await collectHunkHistory(counting, input);
    expect(calls.filter((a) => a[0] === "merge-base")).toHaveLength(1);
    expect(calls.filter((a) => a[0] === "show")).toHaveLength(2);
    expect(calls.filter((a) => a[0] === "log")).toHaveLength(4);
  });
});

describe("collectHunkHistory — rebase and cherry-pick", () => {
  it("rebase: theirs is the replayed commit", async () => {
    repo = makeRepo();
    mergeConflict(repo);
    repo.git(["switch", "-q", "side"]);
    repo.git(["rebase", "main"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "rebase", "REBASE_HEAD") });
    expect(h.ours.commits.map((c) => c.subject)).toEqual(["ours: suffix c"]);
    expect(h.theirs.commits.map((c) => c.subject)).toEqual(["theirs: shout c"]);
  });

  it("cherry-pick: theirs is exactly the picked commit", async () => {
    repo = makeRepo();
    mergeConflict(repo);
    repo.git(["switch", "-q", "side"]);
    repo.write("f.txt", lines("a", "b", "C-theirs-2", "d", "e"));
    repo.git(["commit", "-qam", "theirs: second edit"]);
    repo.git(["switch", "-q", "main"]);
    repo.git(["cherry-pick", "side"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "cherry-pick", "CHERRY_PICK_HEAD") });
    expect(h.theirs.commits.map((c) => c.subject)).toEqual(["theirs: second edit"]);
  });
});

describe("collectHunkHistory — degraded cases", () => {
  it("no-sha when a SHA is missing, without calling git", async () => {
    const never: GitRunner = () => { throw new Error("must not be called"); };
    const h = await collectHunkHistory(never, {
      filePath: "f.txt", hunk: { oursLines: ["x"], theirsLines: ["y"], startLine: 1 }, refs: { oursSha: "abc" },
    });
    expect(h).toEqual({
      mergeBase: null,
      ours: { status: "unavailable", reason: "no-sha", commits: [] },
      theirs: { status: "unavailable", reason: "no-sha", commits: [] },
    });
  });

  it("no-merge-base for unrelated histories", async () => {
    repo = makeRepo();
    repo.write("f.txt", lines("a", "ours"));
    repo.git(["add", "."]);
    repo.git(["commit", "-qm", "ours root"]);
    repo.git(["switch", "-q", "--orphan", "other"]);
    repo.write("f.txt", lines("a", "theirs"));
    repo.git(["add", "."]);
    repo.git(["commit", "-qm", "theirs root"]);
    repo.git(["switch", "-q", "main"]);
    repo.git(["merge", "--allow-unrelated-histories", "other"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "merge", "MERGE_HEAD") });
    expect(h.mergeBase).toBeNull();
    expect(h.ours.reason).toBe("no-merge-base");
    expect(h.theirs.reason).toBe("no-merge-base");
  });

  it("side-deleted with a file-level fallback when a side removed the block", async () => {
    repo = makeRepo();
    repo.write("f.txt", lines("a", "b", "c", "d", "e"));
    repo.git(["add", "."]);
    repo.git(["commit", "-qm", "base"]);
    repo.git(["switch", "-qc", "side"]);
    repo.write("f.txt", lines("a", "b", "C-theirs", "d", "e"));
    repo.git(["commit", "-qam", "theirs: edit c"]);
    repo.git(["switch", "-q", "main"]);
    repo.write("f.txt", lines("a", "b", "d", "e"));
    repo.git(["commit", "-qam", "ours: drop c"]);
    repo.git(["merge", "side"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    expect(hunk.oursLines).toEqual([]);
    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "merge", "MERGE_HEAD") });
    expect(h.ours).toMatchObject({ status: "ok", reason: "side-deleted" });
    expect(h.ours.commits.map((c) => c.subject)).toEqual(["ours: drop c"]);
    expect(h.ours.commits[0].rangeDiff).toBe("");
    expect(h.theirs.status).toBe("ok");
  });

  it("filters a pure move and keeps the real edit", async () => {
    repo = makeRepo();
    repo.write("f.txt", lines("a", "b", "c", "d", "e"));
    repo.git(["add", "."]);
    repo.git(["commit", "-qm", "base"]);
    repo.git(["switch", "-qc", "side"]);
    repo.write("f.txt", lines("a", "b", "C-theirs", "d", "e"));
    repo.git(["commit", "-qam", "theirs: edit c"]);
    repo.git(["switch", "-q", "main"]);
    repo.write("f.txt", lines("a", "b", "c-ours", "d", "e"));
    repo.git(["commit", "-qam", "ours: edit c"]);
    repo.write("f.txt", lines("a", "b", "  c-ours", "d", "e"));
    repo.git(["commit", "-qam", "ours: reindent only"]);
    repo.git(["merge", "side"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "merge", "MERGE_HEAD") });
    expect(h.ours.commits.map((c) => c.subject)).toEqual(["ours: edit c"]);
  });

  it("keeps the newest reformat commit, without its diff, when it is the side's only change", async () => {
    repo = makeRepo();
    repo.write("f.txt", lines("a", "b", "c", "d", "e"));
    repo.git(["add", "."]);
    repo.git(["commit", "-qm", "base"]);
    repo.git(["switch", "-qc", "side"]);
    repo.write("f.txt", lines("a", "b", "C-theirs", "d", "e"));
    repo.git(["commit", "-qam", "theirs: edit c"]);
    repo.git(["switch", "-q", "main"]);
    repo.write("f.txt", lines("a", "b", "  c", "d", "e"));
    repo.git(["commit", "-qam", "ours: reindent only"]);
    repo.git(["merge", "side"], { allowFail: true });
    const hunk = firstHunk(repo, "f.txt");
    const h = await collectHunkHistory(repo.runner, { filePath: "f.txt", hunk, refs: refs(repo, "merge", "MERGE_HEAD") });
    expect(h.ours.status).toBe("ok");
    expect(h.ours.reason).toBeUndefined();
    expect(h.ours.commits.map((c) => c.subject)).toEqual(["ours: reindent only"]);
    expect(h.ours.commits[0].rangeDiff).toBe("");
  });

  it("locate-failed when the block is not in the side's staged file", async () => {
    repo = makeRepo();
    mergeConflict(repo);
    repo.git(["merge", "side"], { allowFail: true });
    const h = await collectHunkHistory(repo.runner, {
      filePath: "f.txt",
      hunk: { oursLines: ["not in the file"], theirsLines: ["C-theirs"], startLine: 3 },
      refs: refs(repo, "merge", "MERGE_HEAD"),
    });
    expect(h.ours).toEqual({ status: "unavailable", reason: "locate-failed", commits: [] });
    expect(h.theirs.status).toBe("ok");
  });

  it("timeout when the runner never answers, within the budget", async () => {
    const hang: GitRunner = () => new Promise(() => {});
    const t0 = Date.now();
    const h = await collectHunkHistory(hang, {
      filePath: "f.txt", hunk: { oursLines: ["x"], theirsLines: ["y"], startLine: 1 },
      refs: { operation: "merge", oursSha: "a".repeat(40), theirsSha: "b".repeat(40) }, timeoutMs: 50,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.ours.reason).toBe("timeout");
    expect(h.theirs.reason).toBe("timeout");
  });

  it("git-error when the runner rejects or git fails, never throwing", async () => {
    const boom: GitRunner = () => Promise.reject(new Error("spawn ENOENT"));
    const h = await collectHunkHistory(boom, {
      filePath: "f.txt", hunk: { oursLines: ["x"], theirsLines: ["y"], startLine: 1 },
      refs: { operation: "merge", oursSha: "a".repeat(40), theirsSha: "b".repeat(40) },
    });
    expect(h.ours.reason).toBe("git-error");
    expect(new HistoryTimeout()).toBeInstanceOf(Error);
  });
});
