/**
 * @file utils/forgeUrls.ts
 *
 * Web-UI URL builders per forge. Extracted from an inline ternary chain in
 * `useCommitActions.handleViewOnForge` so the per-forge path shapes are pinned
 * by tests rather than buried in a handler.
 */

import { CURSOR_WEB_BASE } from "../composables/forge/types";

/** The subset of `RemoteInfo` these builders need. */
export interface ForgeRemote {
  provider: string;
  owner: string;
  repo: string;
  /** Raw remote URL. Required for Azure DevOps, which needs org + project. */
  url: string;
}

/** Azure DevOps coordinates, which are a triple rather than an owner/repo pair. */
interface AzureRepo {
  org: string;
  project: string;
  repo: string;
}

/**
 * Parse `(org, project, repo)` out of an Azure DevOps remote URL.
 *
 * Mirrors `parse_azure_remote()` in `src-tauri/src/commands/azure.rs` — keep the
 * two in sync. Handles:
 *   - `https://dev.azure.com/{org}/{project}/_git/{repo}`
 *   - `https://{org}@dev.azure.com/{org}/{project}/_git/{repo}`
 *   - `https://{org}.visualstudio.com/{project}/_git/{repo}`
 *   - `https://{org}.visualstudio.com/DefaultCollection/{project}/_git/{repo}`
 *   - `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
 */
export function parseAzureRemote(url: string): AzureRepo | null {
  const stripGit = (s: string) => s.replace(/\.git$/, "");

  // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const sshMarker = "ssh.dev.azure.com:";
  const sshIdx = url.indexOf(sshMarker);
  if (sshIdx !== -1) {
    const rest = stripGit(url.slice(sshIdx + sshMarker.length).replace(/^v3\//, ""));
    const parts = rest.split("/").filter(Boolean);
    if (parts.length >= 3) {
      return { org: parts[0], project: parts[1], repo: parts.slice(2).join("/") };
    }
    return null;
  }

  // HTTPS — strip the scheme, then any `user@` userinfo.
  const afterScheme = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url;
  const at = afterScheme.indexOf("@");
  const afterUserinfo = at === -1 ? afterScheme : afterScheme.slice(at + 1);

  const slash = afterUserinfo.indexOf("/");
  if (slash === -1) return null;
  const host = afterUserinfo.slice(0, slash);
  const path = stripGit(afterUserinfo.slice(slash + 1).replace(/\/+$/, ""));

  const gitMarker = "/_git/";
  const gitIdx = path.indexOf(gitMarker);
  if (gitIdx === -1) return null;
  const left = path.slice(0, gitIdx);
  const repo = path.slice(gitIdx + gitMarker.length);
  if (!repo) return null;

  // dev.azure.com/{org}/{project}/_git/{repo}
  if (host.toLowerCase() === "dev.azure.com") {
    const segs = left.split("/").filter(Boolean);
    if (segs.length >= 2) {
      return { org: segs[0], project: segs.slice(1).join("/"), repo };
    }
    return null;
  }

  // {org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
  const vsSuffix = ".visualstudio.com";
  if (host.toLowerCase().endsWith(vsSuffix)) {
    const org = host.slice(0, host.length - vsSuffix.length);
    const segs = left
      .split("/")
      .filter((s) => s && s.toLowerCase() !== "defaultcollection");
    if (org && segs.length > 0) {
      return { org, project: segs.join("/"), repo };
    }
  }

  return null;
}

/**
 * Best web URL for viewing `sha` of `remote` on its forge, or `null` when no
 * correct URL can be built. Callers surface their own "no remote" message
 * rather than opening something wrong.
 *
 * An unrecognised provider falls back to the GitHub shape, which is the
 * historical behaviour and is right for GitHub Enterprise-ish remotes that
 * detection reports as `github`. Azure DevOps is explicitly handled rather than
 * left to that fallback: it used to produce a `github.com` URL where the commit
 * simply does not exist.
 */
export function forgeCommitUrl(remote: ForgeRemote, sha: string): string | null {
  const { provider, owner, repo, url } = remote;

  if (provider === "azure") {
    const az = parseAzureRemote(url);
    if (!az) return null;
    return `https://dev.azure.com/${az.org}/${az.project}/_git/${az.repo}/commit/${sha}`;
  }

  if (!owner || !repo) return null;

  switch (provider) {
    case "gitlab":
      return `https://gitlab.com/${owner}/${repo}/-/commit/${sha}`;
    case "bitbucket":
      return `https://bitbucket.org/${owner}/${repo}/commits/${sha}`;
    case "cursor":
      // Cursor Origin's commit-permalink shape is undocumented; guessing
      // `/commit/{sha}` risks a 404, so degrade to the repo page, which always
      // resolves. Upgrade once the permalink path is confirmed.
      return `${CURSOR_WEB_BASE}/${owner}/${repo}`;
    default:
      return `https://github.com/${owner}/${repo}/commit/${sha}`;
  }
}
