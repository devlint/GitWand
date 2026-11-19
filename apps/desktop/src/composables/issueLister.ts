/**
 * Which remotes get the `#` issue list in the commit fields (#301, part 4).
 *
 * A remote of no known forge (a bare SSH or NAS remote, a local path, an
 * undetected self-hosted forge) gets none: `forgeFromRemoteInfo` would fall
 * back to GitHub, and every `#` (a C `#include`…) would show a failed fetch.
 */
import type { Issue, RemoteInfo } from "../utils/backend";
import { forgeFromRemoteInfo } from "./forge/useForge";

/** The open issues of `cwd`'s forge, or null when there is no list for it. */
export function issueListerFor(info: RemoteInfo | null, cwd: string): Promise<Issue[]> | null {
  if (!info || info.provider === "unknown") return null;
  const forge = forgeFromRemoteInfo(info);
  return forge.listIssues ? forge.listIssues(cwd, { limit: 100 }) : null;
}
