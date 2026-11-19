/**
 * createdIssueToast (#301, part 4): the notice after an issue is created.
 */
import { describe, it, expect, vi } from "vitest";
import { createdIssueToast, type CreatedIssueToastDeps } from "../createdIssueToast";

function deps(over: Partial<CreatedIssueToastDeps> = {}) {
  let description = "d";
  const d: CreatedIssueToastDeps = {
    t: (k: string, ...a: unknown[]) => (a.length ? `${k}:${a.join(",")}` : k),
    activeCwd: () => "/r",
    message: () => ({ summary: "s", description }),
    setDescription: vi.fn((v: string) => { description = v; }),
    readPushRepo: vi.fn(async () => "me/app"),
    invalidate: vi.fn(),
    notify: vi.fn(),
    ...over,
  };
  return d;
}
const ISSUE = { number: 7, url: "https://github.com/me/app/issues/7" };

describe("createdIssueToast", () => {
  it("a GitWand report gets no action and touches no cache", () => {
    const d = deps();
    const out = createdIssueToast(ISSUE, { toGitwand: true, repo: "devlint/GitWand", cwd: "/r" }, d);
    expect(out.action).toBeUndefined();
    expect(out.link?.url).toBe(ISSUE.url);
    expect(d.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the repository's issues and adds the reference on click", async () => {
    const d = deps();
    const out = createdIssueToast(ISSUE, { toGitwand: false, repo: "me/app", cwd: "/r" }, d);
    expect(d.invalidate).toHaveBeenCalledWith({ cwd: "/r", repo: "me/app" });
    expect(d.readPushRepo).not.toHaveBeenCalled();
    await out.action!.run();
    expect(d.setDescription).toHaveBeenCalledWith("d\n\n#7");
  });

  it("says why nothing was added", async () => {
    const d = deps({ activeCwd: () => "/other" });
    await createdIssueToast(ISSUE, { toGitwand: false, repo: "me/app", cwd: "/r" }, d).action!.run();
    expect(d.setDescription).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("createIssue.addToCommitOtherRepo");
  });
});
