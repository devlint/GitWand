/**
 * PR-number helpers for the dev-server routes, as pure functions so they are
 * unit-tested (src/__tests__/devPrRepo.devserver.test.ts).
 */

/** A PR number from a request (query string or JSON body), or null unless it
 *  is a positive integer: an empty or malformed value must not resolve as PR
 *  #0 or #NaN. */
export function devPrNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
