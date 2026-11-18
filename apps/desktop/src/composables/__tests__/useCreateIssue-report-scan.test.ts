/**
 * useCreateIssue — a switch scans once (#301): the synchronous scan it runs
 * must not be followed by the watcher's debounced copy of the same text.
 */
import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import type { ConflictHunk } from "@gitwand/core";
import type { ForgeProvider } from "../forge/types";

const scan = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../utils/reportGuard", async (orig) => {
  const real = (await orig()) as typeof import("../../utils/reportGuard");
  return {
    ...real,
    scanReportBody: (...args: Parameters<typeof real.scanReportBody>) => {
      scan.calls++;
      return real.scanReportBody(...args);
    },
  };
});

import { useCreateIssue } from "../useCreateIssue";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useCreateIssue — scans", () => {
  it("one scan per switch, not two", async () => {
    const provider = {
      name: "github",
      issueTargets: vi.fn(async () => ({ targets: [{ repo: "me/app", htmlUrl: "", hasIssues: true, isOrigin: true, canTriage: false }], defaultRepo: "me/app" })),
      createIssue: vi.fn(),
    } as unknown as ForgeProvider;
    const api = useCreateIssue({
      cwd: ref("/repo"),
      provider: ref(provider),
      onCreated: vi.fn(),
      report: {
        gitwandWritable: async () => true,
        env: () => ({ version: "1", platform: "x" }),
        secretsOptions: async () => ({ extraPatterns: [], entropyThreshold: 4 }),
        scanDebounceMs: 0,
      },
    });
    await api.openFromResolution({
      kind: "engine",
      path: "a.ts",
      hunk: {
        baseLines: ["a"], oursLines: ["b"], theirsLines: ["c"], startLine: 1, type: "non_overlapping",
        confidence: { score: 90, label: "high", dimensions: {}, boosters: [], penalties: [] },
        explanation: "e", trace: { steps: [], selected: "non_overlapping", summary: "s", hasBase: true },
      } as unknown as ConflictHunk,
      resolvedLines: ["bc"],
    });
    for (let i = 0; i < 4; i++) await flush();
    const before = scan.calls;
    api.setGitwand(true);
    for (let i = 0; i < 4; i++) await flush();
    // One scan = the title, the answer and the description.
    expect(scan.calls - before).toBe(3);
  });
});
