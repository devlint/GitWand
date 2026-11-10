import type { GitPushPullResult } from "./backend";

/**
 * Whether the log must be force-reloaded after a fetch (#287).
 *
 * A forced reload refetches only down to what the user is viewing and lets
 * the background prefetch refill the rest, so doing it after every 30 s
 * background fetch made the Git Tree shrink and refill even when nothing
 * moved. Force only when the fetch moved a ref, when the backend could not
 * tell, or on a manual sync (which refreshes everything by design).
 */
export function shouldForceLogAfterFetch(result: GitPushPullResult, manual: boolean): boolean {
  return manual || result.refsChanged !== false;
}
