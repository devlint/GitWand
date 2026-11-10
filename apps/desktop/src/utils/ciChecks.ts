import type { CICheck } from "./backend";

/**
 * States, upper-cased, that mean a check is queued or running. Forges disagree
 * on where they put it: GitHub leaves `conclusion` empty and sets `state`;
 * GitLab, Bitbucket and Gitea put a running value in `conclusion` itself.
 * GitLab leaves `conclusion` empty before a pipeline starts (`created`,
 * `preparing`, `waiting_for_resource`). Its `manual` and `scheduled` are left
 * out on purpose: they wait on a person or a clock, and polling them would
 * never end.
 */
const RUNNING = new Set([
  "QUEUED", "IN_PROGRESS", "INPROGRESS", "PENDING", "WAITING", "REQUESTED", "RUNNING",
  "CREATED", "PREPARING", "WAITING_FOR_RESOURCE",
]);

/** Conclusions (or, with none, states), upper-cased, of a check that failed. */
const FAILING = new Set([
  "FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE",
]);

function status(check: CICheck): string {
  return (check.conclusion || check.state || "").toUpperCase();
}

/** True while a CI check is queued or running: the live CI tab polls these. */
export function isCheckRunning(check: CICheck): boolean {
  return RUNNING.has(status(check));
}

/**
 * True while a check has no result yet: running, or `EXPECTED` (a required
 * status that has not reported). These block the merge and show ⏳, but an
 * `EXPECTED` check alone is not polled: nothing says it will ever report.
 */
export function isCheckPending(check: CICheck): boolean {
  return isCheckRunning(check) || status(check) === "EXPECTED";
}

/** True when a CI check finished and failed (errored, cancelled, timed out…). */
export function isCheckFailing(check: CICheck): boolean {
  return FAILING.has(status(check));
}

/** The icon of one check in the CI tab. */
export function checkIcon(check: CICheck): string {
  const s = status(check);
  if (s === "SUCCESS") return "✅";
  if (isCheckFailing(check)) return "❌";
  if (s === "EXPIRED") return "⚠️";
  if (isCheckPending(check)) return "⏳";
  if (s === "SKIPPED") return "⏭️";
  return "❓";
}

/**
 * The CI rollup of a finished list of checks, in the PR list's vocabulary
 * (`FAILURE` red, `PENDING` yellow, `SUCCESS` green, `""` no CI). An expired
 * build still blocks the merge, so it reads as pending, like the backends.
 */
export function checksRollup(checks: CICheck[]): string {
  if (checks.length === 0) return "";
  if (checks.some(isCheckFailing)) return "FAILURE";
  if (checks.some((c) => isCheckPending(c) || status(c) === "EXPIRED")) return "PENDING";
  return "SUCCESS";
}
