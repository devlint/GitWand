import { ref, computed } from "vue";
import type { WorkspaceRepoIssues, WorkspaceRepo, Issue } from "../utils/backend";
import { forgeForRepo, isForgeConnected } from "./forge/useForge";
import type { ForgeName } from "./forge/types";
import { useLaunchpadPins } from "./useLaunchpadPins";

export type { WorkspaceRepoIssues };

/** Valid filter values for the Issues tab. */
export type IssueFilter = "" | "assigned" | "mentioned" | "created";

/** The three concrete filters the Issues tab fetches and unions for its badge. */
const FILTERS = ["assigned", "mentioned", "created"] as const;
type ConcreteFilter = (typeof FILTERS)[number];

/** WorkspaceRepoIssues plus the forge that produced it (for avatar resolution). */
interface WorkspaceRepoIssuesWithForge extends WorkspaceRepoIssues {
  forge?: ForgeName;
}

/** An issue enriched with its repo context (for flat list rendering). */
export interface IssueWithRepo extends Issue {
  repoName: string;
  repoPath: string;
  /** Forge that owns this issue — drives the forge avatar lookup. */
  forge?: ForgeName;
}

/**
 * Composable for the Launchpad Issues panel.
 * Aggregates open Issues from all repos in a workspace, dispatching to each
 * repo's ForgeProvider. Repos whose provider has no `listIssues` (Azure) are
 * silently skipped. Repos whose forge is not connected are collected in
 * `needsConnection`.
 *
 * Each call returns a fresh reactive scope — no shared singleton.
 *
 * The three filters (assigned / mentioned / created) are fetched together and
 * cached, so:
 *   - switching the active sub-filter is instant (no refetch), and
 *   - the tab badge (`totalCount`) is the *deduplicated union* of all three —
 *     a stable number that doesn't jump around when you change sub-filter.
 */
export function useLaunchpadIssues() {
  const reposByFilter = ref<Record<ConcreteFilter, WorkspaceRepoIssuesWithForge[]>>({
    assigned: [],
    mentioned: [],
    created: [],
  });
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Currently active filter (drives the visible list). Defaults to "assigned". */
  const activeFilter = ref<IssueFilter>("assigned");
  /** Forges that have repos in the workspace but are not connected yet. */
  const needsConnection = ref<ForgeName[]>([]);

  const { isPinned, isSnoozed } = useLaunchpadPins();

  /** Repos for the active filter — used for per-repo error display. */
  const repos = computed<WorkspaceRepoIssuesWithForge[]>(
    () => reposByFilter.value[(activeFilter.value || "assigned") as ConcreteFilter] ?? []
  );

  function flatten(list: WorkspaceRepoIssuesWithForge[]): IssueWithRepo[] {
    return list.flatMap((r) =>
      r.issues.map((issue) => ({ ...issue, repoName: r.repoName, repoPath: r.repoPath, forge: r.forge }))
    );
  }

  /** Flat list of all non-snoozed issues for the active filter: pinned first, then by updatedAt desc. */
  const allIssues = computed<IssueWithRepo[]>(() =>
    flatten(repos.value)
      .filter((issue) => !isSnoozed(issue.url))
      .sort((a, b) => {
        const aPinned = isPinned(a.url) ? 0 : 1;
        const bPinned = isPinned(b.url) ? 0 : 1;
        if (aPinned !== bPinned) return aPinned - bPinned;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
  );

  /** Flat list of currently-snoozed issues for the active filter (hidden from allIssues). */
  const snoozedIssues = computed<IssueWithRepo[]>(() =>
    flatten(repos.value).filter((issue) => isSnoozed(issue.url))
  );

  /**
   * Deduplicated union of non-snoozed issues across ALL three filters — drives
   * the Issues tab badge. An issue assigned-to-me AND created-by-me counts once.
   */
  const totalCount = computed<number>(() => {
    const seen = new Set<string>();
    for (const f of FILTERS) {
      for (const r of reposByFilter.value[f] ?? []) {
        for (const issue of r.issues) {
          if (!isSnoozed(issue.url)) seen.add(issue.url);
        }
      }
    }
    return seen.size;
  });

  async function refresh(workspaceRepos: WorkspaceRepo[]): Promise<void> {
    loading.value = true;
    error.value = null;
    const unconnected = new Set<ForgeName>();
    try {
      // Resolve each repo's provider once, then fetch all three filters per repo.
      const resolved = await Promise.all(
        workspaceRepos.map(async (repo) => ({ repo, provider: await forgeForRepo(repo.path) }))
      );

      async function listFor(filter: ConcreteFilter): Promise<WorkspaceRepoIssuesWithForge[]> {
        const out = await Promise.all(
          resolved.map(async ({ repo, provider }): Promise<WorkspaceRepoIssuesWithForge | null> => {
            const forge = provider.name as ForgeName;
            if (!isForgeConnected(forge)) {
              unconnected.add(forge);
              return null;
            }
            if (typeof provider.listIssues !== "function") return null; // Azure: unsupported
            try {
              const issues = await provider.listIssues(repo.path, { filter, limit: 100 });
              return { repoPath: repo.path, repoName: repo.name, issues, filter, error: null, forge };
            } catch (e) {
              return {
                repoPath: repo.path, repoName: repo.name, issues: [], filter,
                error: (e as Error).message ?? String(e), forge,
              };
            }
          })
        );
        return out.filter((r): r is WorkspaceRepoIssuesWithForge => r !== null);
      }

      const [assigned, mentioned, created] = await Promise.all([
        listFor("assigned"),
        listFor("mentioned"),
        listFor("created"),
      ]);
      reposByFilter.value = { assigned, mentioned, created };
      needsConnection.value = [...unconnected];
    } catch (e) {
      error.value = (e as Error).message ?? String(e);
    } finally {
      loading.value = false;
    }
  }

  return { repos, allIssues, snoozedIssues, loading, error, activeFilter, totalCount, needsConnection, refresh };
}
