import { describe, it, expect } from "vitest";
import { isCheckRunning, isCheckFailing } from "../ciChecks";

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

  it("is true for GitLab pipelines that have not started yet", () => {
    expect(isCheckRunning(chk("created", ""))).toBe(true);
    expect(isCheckRunning(chk("preparing", ""))).toBe(true);
    expect(isCheckRunning(chk("waiting_for_resource", ""))).toBe(true);
  });

  it("is false for GitLab pipelines waiting on a person or a schedule", () => {
    expect(isCheckRunning(chk("manual", ""))).toBe(false);
    expect(isCheckRunning(chk("scheduled", ""))).toBe(false);
  });

  it("is false once the check has finished", () => {
    expect(isCheckRunning(chk("COMPLETED", "SUCCESS"))).toBe(false);
    expect(isCheckRunning(chk("COMPLETED", "FAILURE"))).toBe(false);
    expect(isCheckRunning(chk("completed", "cancelled"))).toBe(false);
    expect(isCheckRunning(chk("COMPLETED", "SKIPPED"))).toBe(false);
    expect(isCheckRunning(chk("", ""))).toBe(false);
  });
});

describe("isCheckFailing", () => {
  it("is true for failed, errored, cancelled or timed-out checks", () => {
    for (const c of ["FAILURE", "failed", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
      expect(isCheckFailing(chk("COMPLETED", c))).toBe(true);
    }
  });
  it("is false for passing, skipped or running checks", () => {
    for (const c of ["SUCCESS", "SKIPPED", "NEUTRAL", ""]) {
      expect(isCheckFailing(chk("IN_PROGRESS", c))).toBe(false);
    }
  });
});
