import type { CICheck } from "./backend";

/**
 * States, upper-cased, that mean a check is queued or running. Forges disagree
 * on where they put it: GitHub leaves `conclusion` empty and sets `state`;
 * GitLab, Bitbucket and Gitea put a running value in `conclusion` itself.
 * GitLab leaves `conclusion` empty before a pipeline starts (`created`,
 * `preparing`, `waiting_for_resource`). Its `manual` and `scheduled` are not
 * here: they wait on a person or a clock (see WAITING_ON_SOMEONE).
 */
const RUNNING = new Set([
  "QUEUED", "IN_PROGRESS", "INPROGRESS", "PENDING", "WAITING", "REQUESTED", "RUNNING",
  "CREATED", "PREPARING", "WAITING_FOR_RESOURCE",
]);

/** Conclusions (or, with none, states), upper-cased, of a check that failed. */
const FAILING = new Set([
  "FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE",
]);

/**
 * States with no result yet that nothing is working on: a required status
 * that has not reported (`EXPECTED`), a GitLab pipeline waiting on a manual
 * job or a schedule. They block the merge and show ⏳, like the backends'
 * rollups, but polling them could go on for ever.
 */
const WAITING_ON_SOMEONE = new Set(["EXPECTED", "MANUAL", "SCHEDULED"]);

/** Final results that count as passing in every backend's rollup. Gitea's
 *  `warning` is a finished, non-failing commit status. */
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "WARNING"]);

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
  if (isCheckPending(check)) return "⏳";
  if (s === "SKIPPED") return "⏭️";
  return "❓";
}

/**
 * The CI rollup of a list of checks, in the PR list's vocabulary and by the
 * backends' own rule (`rollup_from_check_runs`, `rollup_from_checks`,
 * `bb_rollup_from_statuses`, `gl_status_to_rollup`): any failure is
 * `FAILURE`; every check passed (success, neutral, skipped, warning) is
 * `SUCCESS`; a check still pending or expired is `PENDING`; no checks is `""`.
 *
 * `null` means "don't know", and the caller leaves the row as it is: a list of
 * skipped checks only (GitHub reads it as SUCCESS, GitLab as no CI), or a
 * finished check whose result this table doesn't know.
 */
export function checksRollup(checks: CICheck[]): string | null {
  if (checks.length === 0) return "";
  if (checks.some(isCheckFailing)) return "FAILURE";
  if (checks.some((c) => isCheckPending(c) || status(c) === "EXPIRED")) return "PENDING";
  if (!checks.every((c) => PASSING.has(status(c)))) return null;
  if (checks.every((c) => status(c) === "SKIPPED")) return null;
  return "SUCCESS";
}
