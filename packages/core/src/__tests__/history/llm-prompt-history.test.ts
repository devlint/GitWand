import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAsync } from "../../resolver/index.js";
import type { LlmEndpoint } from "../../types.js";
import { makeRepo, GIT_TEST_TIMEOUT, type Repo } from "../utils/git-repo.js";

// One repo for the whole file: every test only reads it (the runner runs
// `git log` / `git diff`), and building it spawns about ten git processes.
let repo: Repo;
let fixture: { content: string; oursSha: string; theirsSha: string };
beforeAll(() => { fixture = setup(); }, GIT_TEST_TIMEOUT);
afterAll(() => repo?.cleanup());

const lines = (...l: string[]) => l.join("\n") + "\n";

function capturing(): LlmEndpoint & { prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, async call(p) { prompts.push(p); return "CANNOT_RESOLVE"; } };
}

/** Both sides rewrite the same config block differently: a `complex` hunk. */
function setup(): { content: string; oursSha: string; theirsSha: string } {
  repo = makeRepo();
  repo.write("cfg.txt", lines("start", "level = info", "format = text", "end"));
  repo.git(["add", "."]);
  repo.git(["commit", "-qm", "base"]);
  repo.git(["switch", "-qc", "side"]);
  repo.write("cfg.txt", lines("start", "level = debug", "format = json", "end"));
  repo.git(["commit", "-qam", "theirs: structured debug logs"]);
  repo.git(["switch", "-q", "main"]);
  repo.write("cfg.txt", lines("start", "level = warn", "format = xml", "end"));
  repo.git(["commit", "-qam", "ours: quieter xml logs"]);
  repo.git(["merge", "side"], { allowFail: true });
  return {
    content: readFileSync(join(repo.dir, "cfg.txt"), "utf-8"),
    oursSha: repo.git(["rev-parse", "HEAD"]).trim(),
    theirsSha: repo.git(["rev-parse", "MERGE_HEAD"]).trim(),
  };
}

describe("llm_proposed prompt — history", { timeout: GIT_TEST_TIMEOUT }, () => {
  it("inserts the history section between the context and the hunk", async () => {
    const { content, oursSha, theirsSha } = fixture;
    const endpoint = capturing();
    const result = await resolveAsync(content, "cfg.txt", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
      mergeContext: { operation: "merge", targetSide: "ours", oursSha, theirsSha },
      gitRunner: repo.runner,
    });
    expect(endpoint.prompts).toHaveLength(1);
    const p = endpoint.prompts[0];
    expect(p).toContain("## Why each side changed these lines (since merge-base");
    expect(p).toContain("### ours (HEAD)");
    expect(p).toContain("ours: quieter xml logs");
    expect(p).toContain("### theirs (MERGE_HEAD)");
    expect(p).toContain("theirs: structured debug logs");
    expect(p.indexOf("## Context")).toBeLessThan(p.indexOf("## Why each side"));
    expect(p.indexOf("## Why each side")).toBeLessThan(p.indexOf("## Conflict hunk to resolve"));
    expect(result.hunks[0].trace.llmTrace?.history).toMatchObject({ status: "included", commitCount: 2 });
  });

  it("sends the unchanged prompt and marks history disabled without a runner", async () => {
    const { content, oursSha, theirsSha } = fixture;
    const endpoint = capturing();
    const result = await resolveAsync(content, "cfg.txt", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
      mergeContext: { operation: "merge", targetSide: "ours", oursSha, theirsSha },
    });
    expect(endpoint.prompts[0]).not.toContain("## Why each side");
    expect(endpoint.prompts[0]).toContain("## Conflict hunk to resolve");
    expect(result.hunks[0].trace.llmTrace?.history).toEqual({ status: "disabled", reasons: [], commitCount: 0, estTokens: 0 });
  });

  it("respects history.enabled: false even with a runner", async () => {
    const { content, oursSha, theirsSha } = fixture;
    const endpoint = capturing();
    await resolveAsync(content, "cfg.txt", {
      llmFallback: { enabled: true, endpoint, history: { enabled: false } },
      validationLevel: "off",
      mergeContext: { operation: "merge", targetSide: "ours", oursSha, theirsSha },
      gitRunner: repo.runner,
    });
    expect(endpoint.prompts[0]).not.toContain("## Why each side");
  });

  it("still asks the model, with the unavailable line, when SHAs are missing", async () => {
    const { content } = fixture;
    const endpoint = capturing();
    await resolveAsync(content, "cfg.txt", {
      llmFallback: { enabled: true, endpoint },
      validationLevel: "off",
      gitRunner: repo.runner,
    });
    expect(endpoint.prompts[0]).toContain("History unavailable: the commits of the operation could not be identified.");
  });
});
