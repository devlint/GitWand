/**
 * Task E2 (v3.6.0) — unified AI + static Intelligence orchestrator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghPrDiff = vi.fn();
const ghCheckAnnotations = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    ghPrDiff: (...a: unknown[]) => ghPrDiff(...a),
    ghCheckAnnotations: (...a: unknown[]) => ghCheckAnnotations(...a),
    // usePrPreReview.analyzeFile() calls this for blame context. Left
    // unmocked it falls through to the real dev-server fetch, which has no
    // server to hit in this test and rejects on a timeline that varies by
    // environment — the flaky root cause behind the fixed-sleep wait below.
    getGitBlame: vi.fn(async () => []),
  };
});

const settingsRef = ref<Record<string, unknown>>({
  reviewAiPreReview: true, reviewAiConfidenceThreshold: 0, reviewAiMaxFindings: 15, reviewAiSummary: false,
});
vi.mock("../useSettings", () => ({ useSettings: () => ({ settings: settingsRef }) }));
vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: ref(true),
    rawPrompt: vi.fn(async () => '[{"line": 1, "title": "ai finding", "severity": "risk", "confidence": 90}]'),
  }),
}));

import { usePrPanel } from "../usePrPanel";
import { computeStaticFlags, useReviewIntelligence } from "../useReviewIntelligence";
import { usePrCache, detailKey } from "../usePrCache";
import { normalizeFindingClass } from "../usePrFindingFilter";
import type { ReviewFinding } from "../usePrPreReview";
import type { GitDiff } from "../../utils/backend";

const RAW_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,1 @@",
  " context",
  "+x",
].join("\n");

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 1, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("useReviewIntelligence — merged stream (via usePrPanel)", () => {
  beforeEach(() => {
    settingsRef.value = { reviewAiPreReview: true, reviewAiConfidenceThreshold: 0, reviewAiMaxFindings: 15, reviewAiSummary: false };
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghPrDiff.mockReset().mockResolvedValue(RAW_DIFF);
    ghCheckAnnotations.mockReset().mockResolvedValue([
      { checkName: "lint", path: "a.ts", startLine: 1, endLine: 1, level: "warning", title: "ci finding", message: "" },
    ]);
  });

  it("mergedAnnotationsByFile contains CI + AI entries, distinct by source", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await p.loadAnnotations();

    // The AI pre-review pass is kicked off fire-and-forget by a `watch()`
    // inside useReviewIntelligence, not awaited by selectPr/loadAnnotations
    // — poll the actual condition instead of guessing a fixed sleep, which
    // was flaky whenever the pipeline's promise chain (including a real
    // dev-server fetch for blame, now mocked above) took longer than the
    // guessed delay on a given environment/Node version.
    let merged = p.mergedAnnotationsByFile.value["a.ts"] ?? [];
    for (let i = 0; i < 100 && merged.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
      merged = p.mergedAnnotationsByFile.value["a.ts"] ?? [];
    }

    expect(merged.map((a) => a.source).sort()).toEqual(["ai", "ci"]);
  });
});

describe("useReviewIntelligence — dismissal memory applies on a cache hit too (verifier fix)", () => {
  beforeEach(() => {
    settingsRef.value = { reviewAiPreReview: true, reviewAiConfidenceThreshold: 0, reviewAiMaxFindings: 15, reviewAiSummary: false };
    localStorage.clear();
  });

  it("a dismissed finding class stays hidden after restart even though its findings are already cached at the current headSha", async () => {
    const cwd = "/repo";
    const prNumber = 42;
    const headSha = "sha-cached";
    const key = `${detailKey(cwd, prNumber)}@${headSha}`;

    const dismissedFinding: ReviewFinding = {
      id: "f1", path: "a.ts", line: 1, side: "RIGHT", severity: "nit", confidence: 80,
      title: "unused variable x", detail: "",
    };
    const keptFinding: ReviewFinding = {
      id: "f2", path: "b.ts", line: 2, side: "RIGHT", severity: "risk", confidence: 90,
      title: "possible null deref", detail: "",
    };

    // Simulate a PREVIOUS session: findings were cached at this headSha, and
    // the user dismissed one of them (persisted to the repo-scoped dismissal
    // set) — both survive an app restart via localStorage.
    const cache = usePrCache();
    cache.setFindings(key, [dismissedFinding, keptFinding]);
    cache.addDismissed(cwd, normalizeFindingClass(dismissedFinding));

    // Fresh composable instance — as if the app just restarted and the PR
    // detail is reopened at the same (unchanged) headSha, so `maybeRunPreReview`
    // takes the cache-HIT path rather than re-running the pipeline.
    const intel = useReviewIntelligence({
      cwd: ref(cwd),
      selectedPr: ref({ number: prNumber } as any),
      prDetail: ref({ headSha } as any),
      detailTab: ref("diff"),
      loadDiff: vi.fn(async () => {}),
      diffIndex: ref([]),
      annotationsByFile: ref({}),
    });

    await intel.maybeRunPreReview();

    const ids = intel.preReviewFindings.value.map((f) => f.id);
    expect(ids).not.toContain("f1");
    expect(ids).toContain("f2");
  });
});

describe("computeStaticFlags — regression parity with the pre-E2 aiFlags thresholds", () => {
  const t = (key: string, ...args: Array<string | number>) => {
    let s = key;
    args.forEach((a, i) => { s = s.replace(`{${i}}`, String(a)); });
    return s;
  };

  function bigFile(): GitDiff {
    const lines = Array.from({ length: 250 }, (_, i) => ({ type: "add" as const, content: `x${i}`, newLineNo: i + 1 }));
    return { path: "big.ts", hunks: [{ header: "@@ @@", oldStart: 1, oldCount: 0, newStart: 1, newCount: 250, lines }] };
  }

  it("flags a file with > 200 changed lines (warning)", () => {
    const flags = computeStaticFlags([bigFile()], t as any);
    expect(flags.some((f) => f.severity === "warning" && f.title.includes("pr.intel.flagBigFile"))).toBe(true);
  });

  it("flags a removed export as failure, anchored to the deleted line", () => {
    const diff: GitDiff = {
      path: "a.ts",
      hunks: [{
        header: "@@ @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 0,
        lines: [{ type: "delete", content: "export function foo() {}", oldLineNo: 5 }],
      }],
    };
    const flags = computeStaticFlags([diff], t as any);
    const flag = flags.find((f) => f.title.includes("flagExportRemoved"));
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("failure");
    expect(flag?.side).toBe("LEFT");
    expect(flag?.line).toBe(5);
  });

  it("flags a config file change (notice)", () => {
    const diff: GitDiff = { path: "config.yaml", hunks: [{ header: "@@ @@", oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ type: "add", content: "x", newLineNo: 1 }] }] };
    const flags = computeStaticFlags([diff], t as any);
    expect(flags.some((f) => f.title.includes("flagConfigChange") && f.severity === "notice")).toBe(true);
  });

  it("flags a migration file (warning)", () => {
    const diff: GitDiff = { path: "db/migrate/001.sql", hunks: [{ header: "@@ @@", oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ type: "add", content: "x", newLineNo: 1 }] }] };
    const flags = computeStaticFlags([diff], t as any);
    expect(flags.some((f) => f.title.includes("flagDbMigration") && f.severity === "warning")).toBe(true);
  });

  it("flags a hunk with > 100 lines only once per file", () => {
    const lines = Array.from({ length: 150 }, (_, i) => ({ type: "add" as const, content: `x${i}`, newLineNo: i + 1 }));
    const diff: GitDiff = { path: "a.ts", hunks: [{ header: "@@ @@", oldStart: 1, oldCount: 0, newStart: 1, newCount: 150, lines }] };
    const flags = computeStaticFlags([diff], t as any);
    expect(flags.filter((f) => f.title.includes("flagBigHunk"))).toHaveLength(1);
  });

  it("returns [] for a small, unremarkable diff", () => {
    const diff: GitDiff = { path: "a.ts", hunks: [{ header: "@@ @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{ type: "context", content: "x", oldLineNo: 1, newLineNo: 1 }] }] };
    expect(computeStaticFlags([diff], t as any)).toEqual([]);
  });
});
