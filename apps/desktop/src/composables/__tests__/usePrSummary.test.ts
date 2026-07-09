/**
 * Task D1 (v3.6.0) — AI PR summary generator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };
const gitExecMock = vi.fn();

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({ isAvailable: isAvailableRef, rawPrompt: (...a: unknown[]) => rawPromptMock(...a) }),
}));
vi.mock("../../utils/backend", () => ({ gitExec: (...a: unknown[]) => gitExecMock(...a) }));

import { usePrSummary, buildSummaryPrompt } from "../usePrSummary";

describe("buildSummaryPrompt", () => {
  it("includes commit titles and a per-file +/- count", () => {
    const prompt = buildSummaryPrompt(
      [{ path: "a.ts", raw: "+line1\n+line2\n-old" }],
      ["fix: handle null case"],
    );
    expect(prompt).toContain("fix: handle null case");
    expect(prompt).toContain("a.ts (+2/-1)");
  });

  it("notes missing commit titles gracefully", () => {
    const prompt = buildSummaryPrompt([{ path: "a.ts", raw: "" }], []);
    expect(prompt).toContain("(no commit titles available)");
  });
});

describe("usePrSummary.generate", () => {
  beforeEach(() => {
    rawPromptMock.mockReset();
    gitExecMock.mockReset();
    isAvailableRef.value = true;
  });

  it("returns the model's text, including fetched commit titles", async () => {
    gitExecMock.mockResolvedValue({ stdout: "fix: bug\nfeat: thing", stderr: "", exitCode: 0 });
    rawPromptMock.mockResolvedValue("What: does X.\nWhy: because Y.\nAffected areas: src/.");
    const { generate } = usePrSummary();
    const summary = await generate({ cwd: "/repo", base: "main", head: "feat", files: [{ path: "a.ts", raw: "+x" }] });
    expect(summary).toContain("What: does X.");
    expect(gitExecMock).toHaveBeenCalledWith("/repo", ["log", "--format=%s", "main..feat"]);
    const [, userPrompt] = rawPromptMock.mock.calls[0];
    expect(userPrompt).toContain("fix: bug");
  });

  it("falls back to origin/<base>..origin/<head> when the plain range fails", async () => {
    gitExecMock
      .mockResolvedValueOnce({ stdout: "", stderr: "unknown revision", exitCode: 128 })
      .mockResolvedValueOnce({ stdout: "chore: setup", stderr: "", exitCode: 0 });
    rawPromptMock.mockResolvedValue("summary");
    const { generate } = usePrSummary();
    await generate({ cwd: "/repo", base: "main", head: "feat", files: [{ path: "a.ts", raw: "+x" }] });
    expect(gitExecMock).toHaveBeenCalledTimes(2);
    expect(gitExecMock).toHaveBeenLastCalledWith("/repo", ["log", "--format=%s", "origin/main..origin/feat"]);
  });

  it("generates from the file index alone when no commit titles are found", async () => {
    gitExecMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    rawPromptMock.mockResolvedValue("summary");
    const { generate } = usePrSummary();
    const summary = await generate({ cwd: "/repo", base: "main", head: "feat", files: [{ path: "a.ts", raw: "+x" }] });
    expect(summary).toBe("summary");
  });

  it("returns '' when the AI provider is unavailable", async () => {
    isAvailableRef.value = false;
    const { generate } = usePrSummary();
    const summary = await generate({ cwd: "/repo", base: "main", head: "feat", files: [{ path: "a.ts", raw: "+x" }] });
    expect(summary).toBe("");
    expect(rawPromptMock).not.toHaveBeenCalled();
  });

  it("returns '' for an empty diff (no files)", async () => {
    const { generate } = usePrSummary();
    const summary = await generate({ cwd: "/repo", base: "main", head: "feat", files: [] });
    expect(summary).toBe("");
    expect(rawPromptMock).not.toHaveBeenCalled();
  });
});
