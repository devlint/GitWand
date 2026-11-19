/**
 * Which remotes get the `#` issue list in the commit fields (#301, part 4).
 *
 * A remote of no known forge (a bare SSH or NAS remote, a local path, an
 * undetected self-hosted forge) gets none: `forgeFromRemoteInfo` would fall
 * back to GitHub, and every `#` (a C `#include`…) would show a failed fetch.
 * Nor does a forge with no account connected.
 */
import type { Issue, RemoteInfo } from "../utils/backend";
import { forgeFromRemoteInfo, isForgeConnected } from "./forge/useForge";
import type { ForgeName } from "./forge/types";

/** The open issues of `cwd`'s forge, or null when there is no list for it. */
export function issueListerFor(info: RemoteInfo | null, cwd: string): Promise<Issue[]> | null {
  if (!info || info.provider === "unknown") return null;
  const forge = forgeFromRemoteInfo(info);
  // As Today does: GitHub always (gh, a token), the others with an account
  // connected in GitWand; without one every `#` would show a failed fetch.
  if (!isForgeConnected(forge.name as ForgeName)) return null;
  return forge.listIssues ? forge.listIssues(cwd, { limit: 100 }) : null;
}
