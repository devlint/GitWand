import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat" };
const state = { op: "merge" as string, rc: "" };

vi.mock("../../utils/backend", () => ({
  gitExec: async (cwd: string, args: string[]) => {
    try {
      return { stdout: execFileSync("git", args, { cwd, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }), stderr: "", exitCode: 0 };
    } catch (e: any) {
      return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), exitCode: e.status ?? 1 };
    }
  },
  gitRepoState: async (cwd: string) => ({
    state: state.op, hasConflict: true, targetBranch: null, step: 0, total: 0,
    operationHead: state.op === "clean" ? null : execFileSync("git", ["rev-parse", "MERGE_HEAD"], { cwd, encoding: "utf-8", env: ENV }).trim(),
  }),
  readGitwandrc: async () => state.rc,
}));

import {
  effectiveHistoryConfig, detectHistoryRefs, createHunkHistoryRenderer, makeGitRunner,
} from "../useConflictHistory";
import { parseLlmFallbackFromRc } from "../../utils/llmFallbackRc";

let dir: string;
const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  localStorage.clear();
  state.op = "merge";
  state.rc = "";
  dir = mkdtempSync(join(tmpdir(), "gitwand-desk-hist-"));
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@e"]); g(["config", "user.name", "T"]);
  writeFileSync(join(dir, "f.txt"), "a\nb\nc\n"); g(["add", "."]); g(["commit", "-qm", "base"]);
  g(["switch", "-qc", "side"]); writeFileSync(join(dir, "f.txt"), "a\nB-theirs\nc\n"); g(["commit", "-qam", "theirs edit"]);
  g(["switch", "-q", "main"]); writeFileSync(join(dir, "f.txt"), "a\nB-ours\nc\n"); g(["commit", "-qam", "ours edit"]);
  try { g(["merge", "side"]); } catch { /* conflict expected */ }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hunk = { oursLines: ["B-ours"], theirsLines: ["B-theirs"], startLine: 2 };

describe("effectiveHistoryConfig", () => {
  it("app settings apply unless .gitwandrc turns history off", () => {
    expect(effectiveHistoryConfig({ aiHistoryEnabled: true, aiHistoryBudgetTokens: 900 })).toEqual({ enabled: true, budgetTokens: 900 });
    expect(effectiveHistoryConfig({ aiHistoryEnabled: true, aiHistoryBudgetTokens: 900 }, { enabled: false })).toEqual({ enabled: false, budgetTokens: 900 });
    expect(effectiveHistoryConfig({ aiHistoryEnabled: false, aiHistoryBudgetTokens: 900 }, { enabled: true })).toEqual({ enabled: false, budgetTokens: 900 });
    expect(effectiveHistoryConfig({ aiHistoryEnabled: true, aiHistoryBudgetTokens: 900 }, { budgetTokens: 3000 })).toEqual({ enabled: true, budgetTokens: 3000 });
    expect(effectiveHistoryConfig({ aiHistoryEnabled: true, aiHistoryBudgetTokens: 5 })).toEqual({ enabled: true, budgetTokens: 200 });
  });
});

describe("parseLlmFallbackFromRc", () => {
  it("normalizes the history block", () => {
    expect(parseLlmFallbackFromRc('{"llmFallback":{"enabled":true,"history":{"enabled":false,"budgetTokens":1}}}')?.history)
      .toEqual({ enabled: false, budgetTokens: 200 });
  });
});

describe("detectHistoryRefs", () => {
  it("maps the repo state to operation + SHAs", async () => {
    const refs = await detectHistoryRefs(dir);
    expect(refs).toEqual({ operation: "merge", oursSha: g(["rev-parse", "HEAD"]).trim(), theirsSha: g(["rev-parse", "MERGE_HEAD"]).trim() });
  });
  it("returns {} outside an operation", async () => {
    state.op = "clean";
    expect(await detectHistoryRefs(dir)).toEqual({});
  });
});

describe("createHunkHistoryRenderer", () => {
  it("renders the section for a hunk", async () => {
    const render = createHunkHistoryRenderer(dir);
    const text = await render("f.txt", hunk);
    expect(text).toContain("### ours (HEAD)");
    expect(text).toContain("ours edit");
    expect(text).toContain("theirs edit");
  });
  it("returns undefined when disabled in settings", async () => {
    localStorage.setItem("gitwand-settings", JSON.stringify({ aiHistoryEnabled: false }));
    expect(await createHunkHistoryRenderer(dir)("f.txt", hunk)).toBeUndefined();
  });
  it("honours a settings change on the next request of the same renderer", async () => {
    const render = createHunkHistoryRenderer(dir);
    expect(await render("f.txt", hunk)).toContain("ours edit");
    localStorage.setItem("gitwand-settings", JSON.stringify({ aiHistoryEnabled: false }));
    expect(await render("f.txt", hunk)).toBeUndefined();
  });
  it("returns undefined when .gitwandrc forbids it", async () => {
    state.rc = '{"llmFallback":{"history":{"enabled":false}}}';
    expect(await createHunkHistoryRenderer(dir)("f.txt", hunk)).toBeUndefined();
  });
  it("makeGitRunner maps TerminalResult to the core shape", async () => {
    expect(await makeGitRunner(dir)(["rev-parse", "--is-inside-work-tree"])).toEqual({ stdout: "true\n", exitCode: 0 });
  });
});
