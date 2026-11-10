import type { CICheck } from "./backend";

/**
 * States, upper-cased, that mean a check is queued or running. Forges disagree
 * on where they put it: GitHub leaves `conclusion` empty and sets `state`;
 * GitLab, Bitbucket and Gitea put a running value in `conclusion` itself.
 * GitLab leaves `conclusion` empty before a pipeline starts (`created`,
 * `preparing`, `waiting_for_resource`). Its `manual` and `scheduled` are not
 * here: they wait on a person or a clock (see ON_HOLD).
 */
const RUNNING = new Set([
  "QUEUED", "IN_PROGRESS", "INPROGRESS", "PENDING", "REQUESTED", "RUNNING",
  "CREATED", "PREPARING", "WAITING_FOR_RESOURCE",
]);

/** Conclusions (or, with none, states), upper-cased, of a check that failed. */
const FAILING = new Set([
  "FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE",
]);

/**
 * States with no result yet that nothing is working on: a required status
 * that has not reported (`EXPECTED`), an approval (GitHub's `WAITING` for an
 * environment, Azure's policies other than an automatic build). They block
 * the merge and show ⏳, but polling them could go on for ever.
 */
const WAITING_ON_SOMEONE = new Set(["EXPECTED", "WAITING"]);

/**
 * A GitLab pipeline waiting on a manual job or a schedule. Not finished (⏳),
 * not polled, and not blocking: GitLab lets such an MR merge unless the
 * project requires pipelines to succeed, which its own mergeability reports.
 */
const ON_HOLD = new Set(["MANUAL", "SCHEDULED"]);

function status(check: CICheck): string {
  return (check.conclusion || check.state || "").toUpperCase();
}

/** True while a CI check is queued or running: the live CI tab polls these. */
export function isCheckRunning(check: CICheck): boolean {
  return RUNNING.has(status(check));
}

/** True while a check has no result yet: running, or waiting on someone. */
export function isCheckPending(check: CICheck): boolean {
  return isCheckRunning(check) || WAITING_ON_SOMEONE.has(status(check));
}

/** True when a CI check finished and failed (errored, cancelled, timed out…). */
export function isCheckFailing(check: CICheck): boolean {
  return FAILING.has(status(check));
}

/**
 * True when a check stands in the way of a merge: it failed, its build expired
 * (it needs a re-queue), or it has no result yet. The merge banner's rule.
 */
export function isCheckBlocking(check: CICheck): boolean {
  return isCheckFailing(check) || status(check) === "EXPIRED" || isCheckPending(check);
}

/** The icon of one check in the CI tab. */
export function checkIcon(check: CICheck): string {
  const s = status(check);
  if (s === "SUCCESS") return "✅";
  if (isCheckFailing(check)) return "❌";
  if (s === "EXPIRED" || s === "WARNING") return "⚠️";
  if (isCheckPending(check) || ON_HOLD.has(s)) return "⏳";
  if (s === "SKIPPED") return "⏭️";
  return "❓";
}

/**
 * A PR's overall CI status as the backend computed it for its detail
 * (`checksStatus`), in the PR list's vocabulary (`checksRollup`): every
 * backend builds both with the same rule (GitHub's also counts legacy commit
 * statuses, which the CI tab's check-runs don't show), so this, not the CI
 * tab's list, is what the list dot should follow. `null` for a value this
 * table doesn't know: the caller leaves the dot alone.
 */
export function rollupFromDetailStatus(status: string): string | null {
  const s = (status || "").toUpperCase();
  if (s === "SUCCESS" || s === "PASS") return "SUCCESS";
  if (s === "FAILURE" || s === "FAIL" || s === "ERROR") return "FAILURE";
  if (s === "PENDING" || s === "EXPECTED") return "PENDING";
  if (s === "" || s === "UNKNOWN") return "";
  return null;
}

/** The icon of a PR's overall CI status (`checksStatus`). */
export function checksIcon(status: string): string {
  const r = rollupFromDetailStatus(status);
  if (r === "SUCCESS") return "✅";
  if (r === "FAILURE") return "❌";
  if (r === "PENDING") return "⏳";
  return "";
}

/**
 * The commit the checks ran on, when it is not `headSha`: after a push, the
 * list can still be the previous commit's (GitLab until the new pipeline is
 * created; Azure until the policy re-queues its build), or ahead of a detail
 * fetched before the push. `null` when they match, or when nothing says:
 * no head, or no check that names its commit (an empty list, an Azure
 * reviewer policy, an old cache). One check on the head is enough to count
 * the list as the head's: a forge can mix commits (an Azure build not yet
 * re-queued next to one that was), and that list already shows the head's.
 */
export function checksCommitMismatch(checks: CICheck[], headSha: string | null | undefined): string | null {
  if (!headSha) return null;
  const shas = checks.map((c) => c.commitSha ?? "").filter(Boolean);
  if (shas.length === 0 || shas.includes(headSha)) return null;
  return shas[0];
}
