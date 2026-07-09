/**
 * Task C1 (v3.6.0) — local multi-hop pre-review engine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitDiff, BlameLine } from "../../utils/backend";

const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };
const getGitBlameMock = vi.fn();

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: isAvailableRef,
    rawPrompt: (...a: unknown[]) => rawPromptMock(...a),
  }),
}));

vi.mock("../../utils/backend", () => ({
  getGitBlame: (...a: unknown[]) => getGitBlameMock(...a),
}));

import {
  usePrPreReview,
  parseFindings,
  computeImportedByCount,
  importSourcesForFile,
  summarizeBlameForFile,
  buildUserPrompt,
} from "../usePrPreReview";

function diffFile(path: string, lines: { type: "add" | "delete" | "context"; content: string; newLineNo?: number; oldLineNo?: number }[]): GitDiff {
  return {
    path,
    hunks: [{ header: "@@ -1,1 +1,1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines }],
  };
}

function blameLine(overrides: Partial<BlameLine> = {}): BlameLine {
  return {
    hash: "abc1234", hashFull: "abc1234full", finalLine: 1, origLine: 1,
    author: "alice", authorDate: "2026-01-01", summary: "fix bug", content: "code",
    ...overrides,
  };
}

describe("parseFindings", () => {
  it("recovers a JSON array from a ```json fence", () => {
    const raw = "```json\n[{\"line\": 3, \"title\": \"t\", \"severity\": \"risk\", \"confidence\": 80, \"detail\": \"d\"}]\n```";
    const findings = parseFindings(raw, "a.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "a.ts", line: 3, severity: "risk", confidence: 80, title: "t", detail: "d" });
    expect(findings[0].id).toBeTruthy();
  });

  it("recovers a JSON array embedded in surrounding prose", () => {
    const raw = 'Here is my review:\n[{"line": 1, "title": "x"}]\nThanks!';
    expect(parseFindings(raw, "a.ts")).toHaveLength(1);
  });

  it("clamps confidence to 0-100", () => {
    const raw = '[{"line": 1, "title": "x", "confidence": 500}, {"line": 2, "title": "y", "confidence": -20}]';
    const findings = parseFindings(raw, "a.ts");
    expect(findings[0].confidence).toBe(100);
    expect(findings[1].confidence).toBe(0);
  });

  it("coerces an unrecognized severity to 'suggestion'", () => {
    const raw = '[{"line": 1, "title": "x", "severity": "catastrophic"}]';
    expect(parseFindings(raw, "a.ts")[0].severity).toBe("suggestion");
  });

  it("drops entries missing line or title", () => {
    const raw = '[{"title": "no line"}, {"line": 1}, {"line": 2, "title": "ok"}]';
    const findings = parseFindings(raw, "a.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("ok");
  });

  it("assigns a stable id for the same path+line+title", () => {
    const raw = '[{"line": 5, "title": "same"}]';
    const a = parseFindings(raw, "a.ts")[0].id;
    const b = parseFindings(raw, "a.ts")[0].id;
    expect(a).toBe(b);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseFindings("not json at all", "a.ts")).toEqual([]);
  });

  it("returns [] when the top-level value isn't an array", () => {
    expect(parseFindings('{"line": 1, "title": "x"}', "a.ts")).toEqual([]);
  });
});

describe("dependency hop", () => {
  it("importSourcesForFile extracts specifiers from added/context lines, ignoring deletes", () => {
    const file = diffFile("a.ts", [
      { type: "add", content: "import { b } from './b';", newLineNo: 1 },
      { type: "delete", content: "import { old } from './old';", oldLineNo: 1 },
    ]);
    expect(importSourcesForFile(file)).toEqual(["./b"]);
  });

  it("computeImportedByCount counts diff files that import the target file", () => {
    const a = diffFile("a.ts", [{ type: "add", content: "import { b } from './b';", newLineNo: 1 }]);
    const b = diffFile("b.ts", [{ type: "context", content: "export const b = 1;" }]);
    const c = diffFile("c.ts", [{ type: "add", content: "import { b } from './b';", newLineNo: 1 }]);
    expect(computeImportedByCount(b, [a, c])).toBe(2);
    expect(computeImportedByCount(a, [b, c])).toBe(0);
  });

  it("computeImportedByCount ignores bare package specifiers", () => {
    const a = diffFile("a.ts", [{ type: "add", content: "import react from 'react';", newLineNo: 1 }]);
    const react = diffFile("react.ts", []);
    expect(computeImportedByCount(react, [a])).toBe(0);
  });
});

describe("history hop", () => {
  it("summarizeBlameForFile matches blame entries to the file's added lines", () => {
    const file = diffFile("a.ts", [{ type: "add", content: "x", newLineNo: 5 }]);
    const blame = [blameLine({ finalLine: 5, author: "bob", summary: "add x" }), blameLine({ finalLine: 99 })];
    expect(summarizeBlameForFile(blame, file)).toEqual(["bob: add x"]);
  });

  it("dedupes identical author+summary pairs", () => {
    const file = diffFile("a.ts", [
      { type: "add", content: "x", newLineNo: 5 },
      { type: "add", content: "y", newLineNo: 6 },
    ]);
    const blame = [blameLine({ finalLine: 5 }), blameLine({ finalLine: 6 })];
    expect(summarizeBlameForFile(blame, file)).toEqual(["alice: fix bug"]);
  });
});

describe("buildUserPrompt", () => {
  it("includes the imported-by-N-diff-files signal", () => {
    const file = diffFile("b.ts", [{ type: "add", content: "export const b = 1;", newLineNo: 1 }]);
    const prompt = buildUserPrompt(file, 2, [], 6000);
    expect(prompt).toContain("Imported by 2 other file(s) in this diff.");
  });
});

describe("usePrPreReview.analyzeFile", () => {
  beforeEach(() => {
    rawPromptMock.mockReset();
    getGitBlameMock.mockReset().mockResolvedValue([]);
    isAvailableRef.value = true;
  });

  it("returns findings parsed from the AI response", async () => {
    rawPromptMock.mockResolvedValue('[{"line": 2, "title": "missing null check", "severity": "risk", "confidence": 70}]');
    const { analyzeFile } = usePrPreReview();
    const file = diffFile("a.ts", [{ type: "add", content: "x.y()", newLineNo: 2 }]);
    const findings = await analyzeFile(file, { cwd: "/repo", otherDiffFiles: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("missing null check");
  });

  it("returns [] gracefully when the model returns junk", async () => {
    rawPromptMock.mockResolvedValue("I refuse to answer in JSON.");
    const { analyzeFile } = usePrPreReview();
    const file = diffFile("a.ts", [{ type: "add", content: "x", newLineNo: 1 }]);
    expect(await analyzeFile(file, { cwd: "/repo", otherDiffFiles: [] })).toEqual([]);
  });

  it("returns [] when the AI provider is unavailable, without calling rawPrompt", async () => {
    isAvailableRef.value = false;
    const { analyzeFile } = usePrPreReview();
    const file = diffFile("a.ts", [{ type: "add", content: "x", newLineNo: 1 }]);
    expect(await analyzeFile(file, { cwd: "/repo", otherDiffFiles: [] })).toEqual([]);
    expect(rawPromptMock).not.toHaveBeenCalled();
  });

  it("calls getGitBlame for the file and includes its summary in the prompt", async () => {
    getGitBlameMock.mockResolvedValue([blameLine({ finalLine: 2, author: "carol", summary: "initial impl" })]);
    rawPromptMock.mockResolvedValue("[]");
    const { analyzeFile } = usePrPreReview();
    const file = diffFile("a.ts", [{ type: "add", content: "x", newLineNo: 2 }]);
    await analyzeFile(file, { cwd: "/repo", otherDiffFiles: [] });
    expect(getGitBlameMock).toHaveBeenCalledWith("/repo", "a.ts");
    const [, userPrompt] = rawPromptMock.mock.calls[0];
    expect(userPrompt).toContain("carol: initial impl");
  });
});
