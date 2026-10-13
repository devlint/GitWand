/**
 * Opt-in auto fast-forward after fetch.
 *
 * The pure verdict is table-tested; the git-facing path runs against real
 * temporary repositories (a bare remote, a teammate clone, the user's clone).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "GitWand Test",
    GIT_AUTHOR_EMAIL: "test@gitwand.test",
    GIT_COMMITTER_NAME: "GitWand Test",
    GIT_COMMITTER_EMAIL: "test@gitwand.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EDITOR: "true",
    EDITOR: "true",
    LC_ALL: "C",
  };
}

// Route the module's backend calls to real git / the real .git directory.
vi.mock("../../utils/backend", () => ({
  gitExec: vi.fn(async (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  }),
  // Stand-in for the Rust command, whose re-checks are covered by the Rust
  // tests (ops_fast_forward_tests.rs): here it only performs the merge, so
  // these tests exercise the TS gate in front of it and git's own refusals.
  gitFastForwardToUpstream: vi.fn(async (cwd: string) => {
    const r = spawnSync("git", ["merge", "--ff-only", "--no-stat", "@{upstream}"], { cwd, env: gitEnv(), encoding: "utf-8" });
    const b = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, env: gitEnv(), encoding: "utf-8" });
    return r.status === 0
      ? { fastForwarded: true, behind: 0, branch: (b.stdout ?? "").trim() }
      : { fastForwarded: false, reason: "gitRefused", stderr: r.stderr ?? "", behind: 0 };
  }),
  gitRepoState: vi.fn(async (cwd: string) => {
    const gd = (a: string) =>
      join(cwd, execFileSync("git", ["rev-parse", "--git-path", a], { cwd, encoding: "utf-8" }).trim());
    const has = (a: string) => existsSync(gd(a));
    let state = "clean";
    if (has("rebase-merge") || has("rebase-apply")) state = "rebase";
    else if (has("MERGE_HEAD")) state = "merge";
    else if (has("CHERRY_PICK_HEAD")) state = "cherry_pick";
    else if (has("REVERT_HEAD")) state = "revert";
    return { state, hasConflict: false, operationHead: null, targetBranch: null, step: 0, total: 0 };
  }),
}));

import {
  evaluateAutoFastForward,
  checkAutoFastForward,
  runAutoFastForward,
  type AutoFfFacts,
} from "../useAutoFastForward";

// ─── pure verdict ────────────────────────────────────────────

const PURELY_BEHIND: AutoFfFacts = {
  detached: false,
  hasUpstream: true,
  ahead: 0,
  behind: 2,
  operation: null,
  busy: false,
  conflicts: false,
  trackedEdits: false,
};

describe("evaluateAutoFastForward", () => {
  it("purely behind -> ready", () => {
    expect(evaluateAutoFastForward(PURELY_BEHIND)).toEqual({ kind: "ready" });
  });

  it("not behind -> idle, whatever else is true", () => {
    expect(evaluateAutoFastForward({ ...PURELY_BEHIND, behind: 0 })).toEqual({ kind: "idle" });
    expect(evaluateAutoFastForward({ ...PURELY_BEHIND, behind: 0, trackedEdits: true })).toEqual({ kind: "idle" });
  });

  const blocks: Array<[string, Partial<AutoFfFacts>, string]> = [
    ["detached HEAD", { detached: true }, "detached"],
    ["no upstream", { hasUpstream: false }, "noUpstream"],
    ["operation in progress", { operation: "merge" }, "operation"],
    ["app busy", { busy: true }, "busy"],
    ["conflicts", { conflicts: true }, "conflicts"],
    ["local commits", { ahead: 1 }, "localCommits"],
    ["tracked edits", { trackedEdits: true }, "trackedEdits"],
  ];
  for (const [label, patch, reason] of blocks) {
    it(`${label} -> blocked(${reason})`, () => {
      expect(evaluateAutoFastForward({ ...PURELY_BEHIND, ...patch })).toEqual({ kind: "blocked", reason });
    });
  }

  it("names the FIRST failing condition in the fixed order", () => {
    const facts: AutoFfFacts = {
      detached: true, hasUpstream: false, ahead: 3, behind: 2,
      operation: "rebase", busy: true, conflicts: true, trackedEdits: true,
    };
    const order = ["operation", "detached", "noUpstream", "busy", "conflicts", "localCommits", "trackedEdits"];
    for (const reason of order) {
      expect(evaluateAutoFastForward(facts)).toEqual({ kind: "blocked", reason });
      if (reason === "operation") facts.operation = null;
      if (reason === "detached") facts.detached = false;
      if (reason === "noUpstream") facts.hasUpstream = true;
      if (reason === "busy") facts.busy = false;
      if (reason === "conflicts") facts.conflicts = false;
      if (reason === "localCommits") facts.ahead = 0;
    }
  });
});

// ─── real git ────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}
function commit(cwd: string, file: string, content: string, message: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
}

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** `me` is `behind` commits behind origin/main (already fetched). */
function setup(behind = 2): { me: string; teammate: string } {
  root = mkdtempSync(join(tmpdir(), "gitwand-autoff-"));
  const remote = join(root, "remote.git");
  const teammate = join(root, "teammate");
  const me = join(root, "me");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  git(root, ["clone", "-q", remote, teammate]);
  commit(teammate, "f", "a\nb\nc\n", "base");
  commit(teammate, "g", "g\n", "base2");
  git(teammate, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", remote, me]);
  for (let i = 0; i < behind; i++) commit(teammate, `t${i}`, `${i}\n`, `t${i}`);
  git(teammate, ["push", "-q", "origin", "main"]);
  git(me, ["fetch", "-q"]);
  return { me, teammate };
}

const ctx = { busy: false };
const T = 60_000;

describe("runAutoFastForward (real git)", () => {
  it("purely behind -> fast-forwards, no merge commit", async () => {
    const { me } = setup(2);
    const out = await runAutoFastForward(me, ctx);
    expect(out).toEqual({ kind: "fastForwarded", count: 2, branch: "main" });
    expect(git(me, ["rev-parse", "HEAD"])).toBe(git(me, ["rev-parse", "origin/main"]));
    expect(git(me, ["rev-list", "--merges", "--count", "HEAD"]).trim()).toBe("0");
  }, T);

  it("up to date -> idle", async () => {
    const { me } = setup(0);
    expect(await runAutoFastForward(me, ctx)).toEqual({ kind: "idle" });
  }, T);

  it("untracked files do not block", async () => {
    const { me } = setup(1);
    writeFileSync(join(me, "scratch.txt"), "x\n");
    expect((await runAutoFastForward(me, ctx)).kind).toBe("fastForwarded");
  }, T);

  it("detached HEAD -> blocked, HEAD unmoved", async () => {
    const { me } = setup(1);
    git(me, ["checkout", "-q", "--detach"]);
    const before = git(me, ["rev-parse", "HEAD"]);
    expect(await runAutoFastForward(me, ctx)).toEqual({ kind: "blocked", reason: "detached" });
    expect(git(me, ["rev-parse", "HEAD"])).toBe(before);
  }, T);

  it("no upstream -> blocked", async () => {
    const { me } = setup(1);
    git(me, ["checkout", "-q", "-b", "local-only"]);
    expect(await runAutoFastForward(me, ctx)).toEqual({ kind: "blocked", reason: "noUpstream" });
  }, T);

  it("local commits (diverged) -> blocked, never merges", async () => {
    const { me } = setup(1);
    commit(me, "mine", "m\n", "mine");
    const before = git(me, ["rev-parse", "HEAD"]);
    expect(await runAutoFastForward(me, ctx)).toEqual({ kind: "blocked", reason: "localCommits" });
    expect(git(me, ["rev-parse", "HEAD"])).toBe(before);
  }, T);

  it("unstaged tracked edit -> blocked", async () => {
    const { me } = setup(1);
    writeFileSync(join(me, "f"), "edited\n");
    expect(await runAutoFastForward(me, ctx)).toEqual({ kind: "blocked", reason: "trackedEdits" });
  }, T);

  it("staged edit -> blocked", async () => {
    const { me } = setup(1);
    writeFileSync(join(me, "f"), "edited\n");
    git(me, ["add", "f"]);
    expect(await runAutoFastForward(me, ctx)).toEqual({ kind: "blocked", reason: "trackedEdits" });
  }, T);

  it("merge in progress with conflicts -> blocked (operation outranks conflicts)", async () => {
    const { me } = setup(1);
    git(me, ["checkout", "-q", "-b", "other"]);
    commit(me, "f", "a\nOTHER\nc\n", "other");
    git(me, ["checkout", "-q", "main"]);
    commit(me, "f", "a\nMAIN\nc\n", "main-edit");
    spawnSync("git", ["merge", "other"], { cwd: me, env: gitEnv() });
    const v = await checkAutoFastForward(me, ctx);
    expect(v.verdict).toEqual({ kind: "blocked", reason: "operation" });
    expect(v.facts.conflicts).toBe(true);
  }, T);

  it("conflicts without a recorded operation -> blocked (conflicts)", async () => {
    const { me } = setup(1);
    git(me, ["checkout", "-q", "-b", "other"]);
    commit(me, "f", "a\nOTHER\nc\n", "other");
    git(me, ["checkout", "-q", "main"]);
    commit(me, "f", "a\nMAIN\nc\n", "main-edit");
    spawnSync("git", ["merge", "other"], { cwd: me, env: gitEnv() });
    // Git state says "clean"; the porcelain still shows the unmerged path.
    const backend = await import("../../utils/backend");
    vi.mocked(backend.gitRepoState).mockResolvedValueOnce({
      state: "clean", hasConflict: true, operationHead: null, targetBranch: null, step: 0, total: 0,
    });
    const v = await checkAutoFastForward(me, ctx);
    expect(v.verdict).toEqual({ kind: "blocked", reason: "conflicts" });
  }, T);

  it("cherry-pick in progress -> blocked (operation)", async () => {
    const { me } = setup(1);
    git(me, ["checkout", "-q", "-b", "other"]);
    commit(me, "f", "a\nOTHER\nc\n", "other");
    git(me, ["checkout", "-q", "main"]);
    commit(me, "f", "a\nMAIN\nc\n", "main-edit");
    spawnSync("git", ["cherry-pick", "other"], { cwd: me, env: gitEnv() });
    const v = await checkAutoFastForward(me, ctx);
    expect(v.verdict).toEqual({ kind: "blocked", reason: "operation" });
  }, T);

  it("bisect in progress -> blocked (operation)", async () => {
    const { me } = setup(1);
    git(me, ["bisect", "start"]);
    const v = await checkAutoFastForward(me, ctx);
    expect(v.verdict).toEqual({ kind: "blocked", reason: "operation" });
  }, T);

  it("app busy -> blocked", async () => {
    const { me } = setup(1);
    expect(await runAutoFastForward(me, { busy: true })).toEqual({ kind: "blocked", reason: "busy" });
  }, T);

  it("git refusing the fast-forward is reported, not thrown", async () => {
    const { me } = setup(1);
    // A lock held by someone else makes git refuse while every fact looks ready.
    writeFileSync(join(me, ".git", "index.lock"), "");
    const out = await runAutoFastForward(me, ctx);
    expect(out.kind).toBe("blocked");
    if (out.kind === "blocked") {
      expect(out.reason).toBe("gitRefused");
      expect(out.detail).toBeTruthy();
    }
  }, T);

  it("an untracked file the fast-forward would overwrite -> git refuses, file kept", async () => {
    const { me, teammate } = setup(0);
    commit(teammate, "newfile", "remote\n", "adds newfile");
    git(teammate, ["push", "-q", "origin", "main"]);
    git(me, ["fetch", "-q"]);
    writeFileSync(join(me, "newfile"), "precious\n");
    const out = await runAutoFastForward(me, ctx);
    expect(out).toMatchObject({ kind: "blocked", reason: "gitRefused" });
    expect(git(me, ["status", "--porcelain"]).includes("newfile")).toBe(true);
  }, T);
});
