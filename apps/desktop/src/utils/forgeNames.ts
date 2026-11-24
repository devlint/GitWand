/** Human-facing forge names for "Open on …" / platform labels. */
export const FORGE_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
  cursor: "Cursor Origin",
};

/**
 * The name to show for a `RemoteInfo.provider` id, or null when the forge is
 * not known (`unknown`, no remote): callers then use a forge-less wording.
 */
export function forgeDisplayName(provider: string | null | undefined): string | null {
  if (!provider) return null;
  if (provider === "gitea") return "Gitea";
  return FORGE_LABELS[provider] ?? null;
}
