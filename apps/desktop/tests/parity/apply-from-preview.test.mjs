/**
 * End-to-end: apply from preview, against a real repository (v3.11.0).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * This drives the REAL orchestrator (`useApplyFromPreview`) with its
 * dependencies wired to the dev-server's HTTP routes, which is exactly the
 * shape `pnpm dev:web` runs. Everything else about the feature is covered by
 * unit tests with fakes; what those cannot show is that the sequence actually
 * works on a real merge: that git really halts, that the engine's resolutions
 * really reach disk, that staging really clears the conflict, and that a
 * residual really leaves the merge in progress for the user to finish.
 *
 * The fixture conflicts in two files at once on purpose. `spacing.ts` is a
 * whitespace-only conflict the engine resolves by itself; `hard.ts` is two
 * incompatible rewrites it must refuse. So the correct outcome is "applied
 * one, stopped on the other", which is the whole premise of the feature: stop
 * only on the residual manual hunks.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { startDevServer } from "./dev-server-runner.mjs";
import { fixtureApplyFromPreview } from "./fixtures.mjs";
import { resolve as resolveConflicts } from "../../../../packages/core/src/index.js";
import { useApplyFromPreview } from "../../src/composables/useApplyFromPreview.ts";
import { buildResolvedContent } from "../../src/composables/useGitWand.ts";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

/** Does this repo have a merge in progress? */
function isMerging(cwd) {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "MERGE_HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire the orchestrator's dependencies to the dev-server, mirroring what
 * App.vue wires them to in the app.
 */
function makeDeps(dev, cwd) {
  const post = async (path, body) => {
    const res = await dev.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `${path} failed`);
    return data;
  };

  /** In-memory mirror of the conflicted files, as useGitWand keeps it. */
  let files = [];

  return {
    cwd: () => cwd,
    repoState: async () => {
      const res = await dev.fetch(`/api/git-repo-state?cwd=${encodeURIComponent(cwd)}`);
      return res.json();
    },
    snapshot: async () => ({ id: "test-snapshot" }),
    runMerge: async (ref) => { await post("/api/git-merge", { cwd, branch: ref }); },
    runCherryPick: async () => { throw new Error("not exercised here"); },
    runRebaseOnto: async (onto) => post("/api/git-rebase-onto", { cwd, onto }),
    refresh: async () => {},
    conflictedPaths: () => git(cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean),
    openConflicts: async () => {
      const paths = git(cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      files = [];
      for (const path of paths) {
        const { content } = await post("/api/read-file", { cwd, path });
        files.push({ path, content, result: await resolveConflicts(content, path) });
      }
    },
    resolveAll: async () => {
      for (const f of files) {
        const next = buildResolvedContent(f.content, f.result);
        if (next && next !== f.content) {
          f.content = next;
          f.result = await resolveConflicts(next, f.path);
        }
      }
    },
    saveAll: async () => {
      for (const f of files) await post("/api/write-file", { cwd, path: f.path, content: f.content });
    },
    stage: async (paths) => { await post("/api/git-stage", { cwd, paths }); },
    files: () => files,
    finalize: async () => { await post("/api/git-merge-continue", { cwd }); },
    applyPredicateFor: () => undefined,
  };
}

describe("end-to-end: apply from preview", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("applies what it can, stops on the rest, and leaves the merge in progress", async () => {
    const cwd = fixtureApplyFromPreview();
    const deps = makeDeps(dev, cwd);
    const { apply } = useApplyFromPreview(deps);

    const out = await apply("merge", "topic", 2);

    // Stopped on the residual, deliberately not finished.
    expect(out.stoppedReason, JSON.stringify(out)).toBe("residual");
    expect(out.finalized, "the user finishes this themselves").toBe(false);

    // The whitespace-only conflict really was resolved and staged.
    expect(out.filesResolved).toContain("spacing.ts");
    expect(out.appliedHunks).toBeGreaterThan(0);
    const spacing = execFileSync("cat", [`${cwd}/spacing.ts`], { encoding: "utf-8" });
    expect(spacing, "markers gone from the resolved file").not.toContain("<<<<<<<");

    // The incompatible rewrite really was left for the user.
    expect(out.residualFiles).toContain("hard.ts");
    const hard = execFileSync("cat", [`${cwd}/hard.ts`], { encoding: "utf-8" });
    expect(hard, "markers kept for the file we refused").toContain("<<<<<<<");

    // Crucially: the merge is still in progress, so `--continue` is available.
    expect(isMerging(cwd), "MERGE_HEAD must survive a partial apply").toBe(true);
    expect(git(cwd, ["diff", "--name-only", "--diff-filter=U"])).toBe("hard.ts");
  }, 60_000);

  it("a merge with nothing to resolve finishes without opening the resolver", async () => {
    const cwd = fixtureApplyFromPreview();
    // Drop the hard conflict from both sides so the merge is clean.
    git(cwd, ["checkout", "topic", "--quiet"]);
    git(cwd, ["checkout", "main", "--", "hard.ts"]);
    execFileSync("git", ["-C", cwd, "commit", "-am", "align hard.ts", "--quiet"]);
    git(cwd, ["checkout", "main", "--quiet"]);
    git(cwd, ["checkout", "topic", "--", "spacing.ts"]);
    execFileSync("git", ["-C", cwd, "commit", "-am", "align spacing.ts", "--quiet"]);

    const deps = makeDeps(dev, cwd);
    const { apply } = useApplyFromPreview(deps);
    const out = await apply("merge", "topic", 0);

    expect(out.stoppedReason, JSON.stringify(out)).toBe("clean");
    expect(isMerging(cwd), "nothing left in progress").toBe(false);
    expect(git(cwd, ["diff", "--name-only", "--diff-filter=U"])).toBe("");
  }, 60_000);
});
