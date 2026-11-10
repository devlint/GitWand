import type { CICheck } from "./backend";

/**
 * States, upper-cased, that mean a check has not finished. Forges disagree on
 * where they put it: GitHub leaves `conclusion` empty and sets `state`; GitLab,
 * Bitbucket and Gitea put a running value in `conclusion` itself. GitLab
 * leaves `conclusion` empty before a pipeline starts (`created`, `preparing`,
 * `waiting_for_resource`). Its `manual` and `scheduled` are left out on
 * purpose: they wait on a person or a clock, and polling them would never end.
 */
const RUNNING = new Set([
  "QUEUED", "IN_PROGRESS", "INPROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED", "RUNNING",
  "CREATED", "PREPARING", "WAITING_FOR_RESOURCE",
]);

/** True while a CI check is queued or running. */
export function isCheckRunning(check: CICheck): boolean {
  const value = (check.conclusion || check.state || "").toUpperCase();
  return RUNNING.has(value);
}
