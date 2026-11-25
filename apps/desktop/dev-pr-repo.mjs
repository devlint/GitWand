/**
 * Which repo a pull-request number belongs to, for the dev-server — the rules
 * of `pr_lookup_order` / `pr_lookup_moves_on` in
 * src-tauri/src/commands/github_api.rs, as pure functions so they are
 * unit-tested (src/__tests__/devPrRepo.devserver.test.ts) like the Rust ones.
 */

/** The repos a PR number is looked up in, in order: the base repo (where the
 *  list's numbers come from; the fork parent for a fork), then origin for a
 *  PR that only exists on the fork (#262). */
export function devPrLookupOrder(origin, base) {
  return base && base !== origin ? [base, origin] : [origin];
}

/** Whether a failed lookup moves on to the next repo: the PR is not there
 *  (404, 410) or this token cannot read that repo (451, or a 403 such as an
 *  org's SAML enforcement). A rate-limit 403 is the answer. */
export function devPrLookupMovesOn(status, bodyText = "") {
  if (status === 404 || status === 410 || status === 451) return true;
  if (status === 403) return !String(bodyText).toLowerCase().includes("rate limit");
  return false;
}

/** A PR number from a request (query string or JSON body), or null unless it
 *  is a positive integer: an empty or malformed value must not resolve as PR
 *  #0 or #NaN. */
export function devPrNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
