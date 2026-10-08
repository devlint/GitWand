/**
 * AI update of an existing PR description — media survives the rewrite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };
const gitExecMock = vi.fn();

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({ isAvailable: isAvailableRef, rawPrompt: (...a: unknown[]) => rawPromptMock(...a) }),
}));
vi.mock("../../utils/backend", () => ({ gitExec: (...a: unknown[]) => gitExecMock(...a) }));

import { usePrDescription } from "../usePrDescription";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const missing = () => ({ stdout: "", stderr: "", exitCode: 1 });

/** Fake repo: `known` lists the refs rev-parse resolves. */
function fakeGit(known: string[]) {
  gitExecMock.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === "rev-parse") {
      const ref = args[args.length - 1]!.replace(/\^\{commit\}$/, "");
      return known.includes(ref) ? ok(ref) : missing();
    }
    if (args[0] === "log") return ok("--- abc1234\nfeat: add export\n");
    if (args[0] === "diff") return ok(" src/a.ts | 3 ++-\n");
    return missing();
  });
}

const screenshot = "![shot](https://github.com/user-attachments/assets/1111)";
const video = "https://github.com/user-attachments/assets/2222";
const pr = {
  number: 42,
  branch: "feat/export",
  base: "main",
  headSha: "deadbeef",
  body: `## Summary\nAdds export.\n\n${screenshot}\n\n## Demo\n${video}\n`,
};

describe("usePrDescription.update", () => {
  beforeEach(() => {
    rawPromptMock.mockReset();
    gitExecMock.mockReset();
    isAvailableRef.value = true;
    usePrDescription().clearPendingUpdate();
  });

  it("sends placeholders instead of media and restores the originals", async () => {
    fakeGit(["deadbeef", "origin/main"]);
    rawPromptMock.mockResolvedValue("## Summary\nAdds export and import.\n\n[[IMAGE_1]]\n\n## Demo\n[[IMAGE_2]]");

    const { update, pendingUpdate } = usePrDescription();
    const body = await update("/repo", pr);

    const [, userPrompt] = rawPromptMock.mock.calls[0];
    expect(userPrompt).toContain("[[IMAGE_1]]");
    expect(userPrompt).not.toContain("user-attachments");
    expect(body).toBe(`## Summary\nAdds export and import.\n\n${screenshot}\n\n## Demo\n${video}`);
    expect(pendingUpdate.value).toEqual({ cwd: "/repo", number: 42, body });
  });

  it("appends media the model dropped", async () => {
    fakeGit(["deadbeef", "origin/main"]);
    rawPromptMock.mockResolvedValue("## Summary\nRewritten.");
    const body = await usePrDescription().update("/repo", pr);
    expect(body).toBe(`## Summary\nRewritten.\n\n${screenshot}\n\n${video}`);
  });

  it("uses the PR head SHA and origin base for the range", async () => {
    fakeGit(["deadbeef", "origin/main", "main", "feat/export"]);
    rawPromptMock.mockResolvedValue("x");
    await usePrDescription().update("/repo", pr);
    expect(gitExecMock).toHaveBeenCalledWith("/repo", expect.arrayContaining(["log", "origin/main..deadbeef"]));
  });

  it("falls back to origin/<branch> when the head SHA is not local", async () => {
    fakeGit(["origin/feat/export", "main"]);
    rawPromptMock.mockResolvedValue("x");
    await usePrDescription().update("/repo", pr);
    expect(gitExecMock).toHaveBeenCalledWith("/repo", expect.arrayContaining(["log", "main..origin/feat/export"]));
  });

  it("fails without calling the model when the refs are not in the repo", async () => {
    fakeGit([]);
    const { update, updateError, pendingUpdate } = usePrDescription();
    await expect(update("/repo", pr)).rejects.toThrow();
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(updateError.value).toBeTruthy();
    expect(pendingUpdate.value).toBeNull();
  });

  it("strips a markdown fence wrapped around the whole answer", async () => {
    fakeGit(["deadbeef", "origin/main"]);
    rawPromptMock.mockResolvedValue("```markdown\n## Summary\nDone.\n[[IMAGE_1]]\n[[IMAGE_2]]\n```");
    const body = await usePrDescription().update("/repo", pr);
    expect(body).toBe(`## Summary\nDone.\n${screenshot}\n${video}`);
  });
});
