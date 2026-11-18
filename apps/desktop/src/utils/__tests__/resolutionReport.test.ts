/**
 * resolutionReport — the bodies of a "bad resolution" report (#301): for the
 * repository being worked on, or for GitWand's own repository (no path, no
 * repository name, ever).
 */
import { describe, it, expect } from "vitest";
import type { ConflictHunk } from "@gitwand/core";
import {
  fileKind,
  repoReportPrefill,
  gitwandReportPrefill,
  REPORT_BODY_MAX,
  type ResolutionReport,
} from "../resolutionReport";

function hunk(over: Partial<ConflictHunk> = {}): ConflictHunk {
  return {
    baseLines: ["const a = 1;"],
    oursLines: ["const a = 2;"],
    theirsLines: ["const a = 3;"],
    startLine: 10,
    type: "non_overlapping",
    confidence: { score: 90, label: "high", dimensions: {}, boosters: [], penalties: [] },
    explanation: "Both sides changed different lines.",
    trace: { steps: [], selected: "non_overlapping", summary: "non_overlapping matched", hasBase: true },
    ...over,
  } as ConflictHunk;
}

const report = (over: Partial<ResolutionReport> = {}): ResolutionReport => ({
  kind: "engine",
  path: "src/x.ts",
  hunk: hunk(),
  resolvedLines: ["const a = 23;"],
  ...over,
});

const env = { version: "3.13.2", platform: "macOS" };

describe("fileKind", () => {
  it("gives the extension, or a known name, never the raw name", () => {
    expect(fileKind("src/a/b.test.ts")).toBe(".ts");
    expect(fileKind("Cargo.lock")).toBe("Cargo.lock");
    expect(fileKind("deploy/Dockerfile")).toBe("Dockerfile");
    expect(fileKind("config/.env.production")).toBe(".env");
    expect(fileKind("yarn.lock")).toBe("yarn.lock");
    expect(fileKind("pnpm-lock.yaml")).toBe("pnpm-lock.yaml");
    expect(fileKind("LICENSE")).toBe("no extension");
    expect(fileKind("acme-secret-billing")).toBe("no extension");
    expect(fileKind("clients\\acme.bank\\Makefile-x")).toBe("no extension");
    expect(fileKind("src\\acme\\x.ts")).toBe(".ts");
  });
});

describe("repoReportPrefill", () => {
  it("names the file and carries the versions, the result and the reasoning", () => {
    const p = repoReportPrefill(report(), "keep both values");
    expect(p.title).toBe("Bad merge resolution in `src/x.ts`");
    expect(p.body.startsWith("### What it should have been\n\nkeep both values")).toBe(true);
    expect(p.body).toContain("`src/x.ts`");
    for (const s of ["ours", "theirs", "base", "const a = 2;", "const a = 3;", "const a = 1;"]) expect(p.body).toContain(s);
    expect(p.body).toContain("### GitWand's result");
    expect(p.body).toContain("const a = 23;");
    expect(p.body).toContain("Both sides changed different lines.");
    expect(p.body).toContain("`non_overlapping`");
    expect(p.body).toContain("confidence 90 (high)");
  });

  it("leaves the answer section out when nothing was typed", () => {
    expect(repoReportPrefill(report(), "  ").body).not.toContain("What it should have been");
  });

  it("prints no base block for a conflict without one", () => {
    const r = report({ hunk: hunk({ baseLines: [], trace: { steps: [], selected: "non_overlapping", summary: "s", hasBase: false } }) });
    expect(repoReportPrefill(r, "").body).not.toMatch(/\*\*base\*\*/);
  });
});

describe("gitwandReportPrefill", () => {
  it("describes the file by its kind and never by its path or name", () => {
    const p = gitwandReportPrefill(report({ path: "secret-project/billing/x.ts" }), "", env);
    expect(p.title).toBe("Resolver: bad `non_overlapping` resolution (`.ts`)");
    expect(p.body).toContain("GitWand 3.13.2");
    expect(p.body).toContain("macOS");
    expect(p.body).toContain("`.ts`");
    expect(p.body).not.toContain("secret-project");
    expect(p.body).not.toContain("billing");
    expect(p.body).not.toContain("x.ts");
  });

  it("scrubs a .gitwandrc glob and the file's own path or name out of engine text", () => {
    const h = hunk({
      type: "generated_file",
      explanation: "Generated file (user pattern: clients/acme-bank/**) — taken from theirs.",
      trace: { steps: [], selected: "generated_file", summary: "Generated (user pattern: clients/acme-bank/**) in clients/acme-bank/api.ts", hasBase: true },
    });
    const p = gitwandReportPrefill(report({ path: "clients/acme-bank/api.ts", hunk: h }), "", env);
    expect(p.body).not.toContain("acme-bank");
    expect(p.body).not.toContain("api.ts");
    expect(p.body).toContain("user pattern");
  });

  it("names the format resolver when one handled the hunk", () => {
    const p = gitwandReportPrefill(report({ path: "package.json", hunk: hunk({ formatResolver: "json" }) }), "", env);
    expect(p.body).toContain("resolver: `json`");
  });

  it("carries an AI proposal's model, validation and history, never its prompt hash", () => {
    const h = hunk({
      type: "llm_proposed",
      trace: {
        steps: [],
        selected: "llm_proposed",
        summary: "s",
        hasBase: true,
        llmTrace: {
          calledAt: "2026-11-18T10:00:00Z",
          model: "claude-test",
          latencyMs: 1200,
          promptHash: "deadbeefcafe",
          rawResponseTruncated: "…",
          validationScore: 82,
          accepted: true,
          history: { status: "included", reasons: [], commitCount: 4, estTokens: 900 },
        },
      } as ConflictHunk["trace"],
    });
    const p = gitwandReportPrefill(report({ kind: "ai", hunk: h }), "", env);
    expect(p.body).toContain("claude-test");
    expect(p.body).toContain("validation 82");
    expect(p.body).toContain("history: 4 commits");
    expect(p.body).not.toContain("deadbeefcafe");
  });

  it("carries a token-level merge's pass counts", () => {
    const h = hunk({
      type: "token_level_merge",
      trace: {
        steps: [],
        selected: "token_level_merge",
        summary: "s",
        hasBase: true,
        tokenMergeTrace: { mergedLines: ["x"], pass1Count: 3, pass2Count: 1, lineDetails: [] },
      } as ConflictHunk["trace"],
    });
    expect(gitwandReportPrefill(report({ kind: "token", hunk: h }), "", env).body).toContain("pass 1: 3 lines, pass 2: 1 line");
  });

  it("puts the answer first, like the repository report", () => {
    expect(gitwandReportPrefill(report(), "should keep 2", env).body.startsWith("### What it should have been\n\nshould keep 2")).toBe(true);
  });
});

describe("budget", () => {
  it("stays under REPORT_BODY_MAX and says what was cut", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} `.padEnd(40, "x"));
    for (const build of [
      (r: ResolutionReport) => repoReportPrefill(r, ""),
      (r: ResolutionReport) => gitwandReportPrefill(r, "", env),
    ]) {
      const p = build(report({ hunk: hunk({ oursLines: big, theirsLines: big, baseLines: big }), resolvedLines: big }));
      expect(p.body.length).toBeLessThanOrEqual(REPORT_BODY_MAX);
      expect(p.body).toContain("(cut to its first");
    }
  });
});
