import { describe, it, expect } from "vitest";
import {
  isCheckRunning, isCheckPending, isCheckFailing, isCheckBlocking, checkIcon, checksRollup,
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

  it("those are still pending: they block and show the hourglass", () => {
    expect(isCheckPending(chk("manual", ""))).toBe(true);
    expect(isCheckBlocking(chk("scheduled", ""))).toBe(true);
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

describe("checksRollup follows the backends' rule", () => {
  it("no checks → empty", () => expect(checksRollup([])).toBe(""));
  it("any failure → FAILURE", () => {
    expect(checksRollup([chk("COMPLETED", "SUCCESS"), chk("COMPLETED", "TIMED_OUT")])).toBe("FAILURE");
  });
  it("all passed → SUCCESS", () => {
    expect(checksRollup([chk("COMPLETED", "SUCCESS"), chk("COMPLETED", "SKIPPED"), chk("COMPLETED", "NEUTRAL")])).toBe("SUCCESS");
  });
  it("pending or expired → PENDING", () => {
    expect(checksRollup([chk("manual", "")])).toBe("PENDING");
    expect(checksRollup([chk("COMPLETED", "SUCCESS"), chk("COMPLETED", "EXPIRED")])).toBe("PENDING");
  });
  it("Gitea's warning is a finished, passing result", () => {
    expect(checksRollup([chk("warning", "warning")])).toBe("SUCCESS");
    expect(isCheckBlocking(chk("warning", "warning"))).toBe(false);
    expect(checkIcon(chk("warning", "warning"))).toBe("⚠️");
  });
  it("a finished list it cannot read → null, the row is left alone", () => {
    expect(checksRollup([chk("completed", "")])).toBeNull();
    expect(checksRollup([chk("COMPLETED", "WEIRD")])).toBeNull();
  });
  it("only skipped → null (forges disagree)", () => {
    expect(checksRollup([chk("COMPLETED", "SKIPPED")])).toBeNull();
  });
});
