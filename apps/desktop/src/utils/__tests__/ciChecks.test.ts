import { describe, it, expect } from "vitest";
import {
  isCheckRunning, isCheckPending, isCheckFailing, isCheckBlocking, checkIcon, checksIcon,
  rollupFromDetailStatus, checksCommitMismatch, isCheckOnOtherCommit,
} from "../ciChecks";

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

  it("those show the hourglass but do not block the merge", () => {
    // GitLab lets the MR merge unless pipelines must succeed (its own rule).
    expect(isCheckPending(chk("manual", ""))).toBe(false);
    expect(isCheckBlocking(chk("scheduled", ""))).toBe(false);
    expect(isCheckBlocking(chk("manual", ""))).toBe(false);
    expect(checkIcon(chk("manual", ""))).toBe("⏳");
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

describe("EXPECTED (a required status that has not reported)", () => {
  it("is pending (blocks, hourglass) but not running (not polled)", () => {
    expect(isCheckPending(chk("EXPECTED", ""))).toBe(true);
    expect(isCheckRunning(chk("EXPECTED", ""))).toBe(false);
  });
  it("every running check is pending", () => {
    expect(isCheckPending(chk("IN_PROGRESS", ""))).toBe(true);
    expect(isCheckPending(chk("COMPLETED", "SUCCESS"))).toBe(false);
  });
});

describe("isCheckFailing reads the state when there is no conclusion", () => {
  it("is true for a status context in failure or error", () => {
    expect(isCheckFailing(chk("failure", ""))).toBe(true);
    expect(isCheckFailing(chk("ERROR", ""))).toBe(true);
  });
});

describe("checkIcon", () => {
  it("is ❌ for every failing conclusion", () => {
    for (const c of ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"]) {
      expect(checkIcon(chk("COMPLETED", c))).toBe("❌");
    }
  });
  it("is ⏳ for pending, ✅ success, ⚠️ expired, ⏭️ skipped, ❓ otherwise", () => {
    expect(checkIcon(chk("EXPECTED", ""))).toBe("⏳");
    expect(checkIcon(chk("created", ""))).toBe("⏳");
    expect(checkIcon(chk("COMPLETED", "SUCCESS"))).toBe("✅");
    expect(checkIcon(chk("COMPLETED", "EXPIRED"))).toBe("⚠️");
    expect(checkIcon(chk("COMPLETED", "SKIPPED"))).toBe("⏭️");
    expect(checkIcon(chk("COMPLETED", "NEUTRAL"))).toBe("❓");
  });
});

describe("isCheckBlocking", () => {
  it("blocks on failing, expired and pending checks only", () => {
    expect(isCheckBlocking(chk("COMPLETED", "FAILURE"))).toBe(true);
    expect(isCheckBlocking(chk("COMPLETED", "EXPIRED"))).toBe(true);
    expect(isCheckBlocking(chk("IN_PROGRESS", ""))).toBe(true);
    expect(isCheckBlocking(chk("COMPLETED", "SUCCESS"))).toBe(false);
    expect(isCheckBlocking(chk("COMPLETED", "NEUTRAL"))).toBe(false);
  });
});

describe("rollupFromDetailStatus maps the detail's checksStatus to the list's vocabulary", () => {
  it("passes, failures, pending, none", () => {
    expect(rollupFromDetailStatus("success")).toBe("SUCCESS");
    expect(rollupFromDetailStatus("SUCCESS")).toBe("SUCCESS");
    expect(rollupFromDetailStatus("failure")).toBe("FAILURE");
    expect(rollupFromDetailStatus("error")).toBe("FAILURE");
    expect(rollupFromDetailStatus("pending")).toBe("PENDING");
    expect(rollupFromDetailStatus("")).toBe("");
    expect(rollupFromDetailStatus("unknown")).toBe("");
  });
  it("anything else → null", () => {
    expect(rollupFromDetailStatus("warning")).toBeNull();
  });
});

describe("checksIcon (a PR's overall status)", () => {
  it("maps the overall status to an icon", () => {
    expect(checksIcon("success")).toBe("✅");
    expect(checksIcon("PASS")).toBe("✅");
    expect(checksIcon("failure")).toBe("❌");
    expect(checksIcon("pending")).toBe("⏳");
    expect(checksIcon("weird")).toBe("");
  });
});

describe("WAITING (an approval) is pending but not polled", () => {
  it("blocks without polling", () => {
    expect(isCheckRunning(chk("WAITING", ""))).toBe(false);
    expect(isCheckPending(chk("waiting", ""))).toBe(true);
  });
});

describe("checksCommitMismatch", () => {
  const on = (sha: string) => ({ name: "c", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "", commitSha: sha });

  it("names the commit the checks ran on when it is not the head", () => {
    expect(checksCommitMismatch([on("old"), on("old")], "new")).toBe("old");
  });

  it("is null when the checks ran on the head", () => {
    expect(checksCommitMismatch([on("new")], "new")).toBeNull();
  });

  it("names the old commit in a list mixing both (an Azure build not re-queued yet)", () => {
    expect(checksCommitMismatch([on("new"), on("old")], "new")).toBe("old");
  });

  it("isCheckOnOtherCommit judges one check: no commit named is never another's", () => {
    expect(isCheckOnOtherCommit(on("old"), "new")).toBe(true);
    expect(isCheckOnOtherCommit(on("new"), "new")).toBe(false);
    expect(isCheckOnOtherCommit(on(""), "new")).toBe(false);
    expect(isCheckOnOtherCommit(chk("COMPLETED", "SUCCESS"), "new")).toBe(false);
    expect(isCheckOnOtherCommit(on("old"), "")).toBe(false);
  });

  it("is null when nothing says: no check names its commit, no checks, no head", () => {
    expect(checksCommitMismatch([on(""), chk("COMPLETED", "SUCCESS")], "new")).toBeNull();
    expect(checksCommitMismatch([], "new")).toBeNull();
    expect(checksCommitMismatch([on("old")], "")).toBeNull();
    expect(checksCommitMismatch([on("old")], undefined)).toBeNull();
  });
});
