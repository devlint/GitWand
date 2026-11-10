import { describe, it, expect } from "vitest";
import { isCheckRunning } from "../ciChecks";

const chk = (state: string, conclusion: string) => ({ name: "c", state, conclusion, detailsUrl: "" });

describe("isCheckRunning", () => {
  it("is true for a check with no conclusion yet and a pending-looking state (GitHub)", () => {
    expect(isCheckRunning(chk("IN_PROGRESS", ""))).toBe(true);
    expect(isCheckRunning(chk("QUEUED", ""))).toBe(true);
    expect(isCheckRunning(chk("pending", ""))).toBe(true);
  });

  it("is true for forges that put the running state in the conclusion", () => {
    expect(isCheckRunning(chk("running", "IN_PROGRESS"))).toBe(true); // GitLab
    expect(isCheckRunning(chk("in_progress", "pending"))).toBe(true); // Bitbucket
    expect(isCheckRunning(chk("pending", "pending"))).toBe(true); // Gitea
  });

  it("is false once the check has finished", () => {
    expect(isCheckRunning(chk("COMPLETED", "SUCCESS"))).toBe(false);
    expect(isCheckRunning(chk("COMPLETED", "FAILURE"))).toBe(false);
    expect(isCheckRunning(chk("completed", "cancelled"))).toBe(false);
    expect(isCheckRunning(chk("COMPLETED", "SKIPPED"))).toBe(false);
    expect(isCheckRunning(chk("", ""))).toBe(false);
  });
});
