import { ref } from "vue";
import {
  workspacePrsAll,
  workspaceWipAll,
  ghCurrentUser,
  ghPrFiles,
} from "../utils/backend";
import type { WorkspaceRepo } from "../utils/backend";
import type { PrWithRepo } from "./useLaunchpadPrs";
import { concurrentMap } from "../utils/concurrentMap";

export interface OverlappingPr extends PrWithRepo {
  overlappingFiles: string[];
  myContext: "wip" | "branch";
}

export interface TeamMemberActivity {
  login: string;
  prs: PrWithRepo[];
  overlappingPrs: OverlappingPr[];
}

// Module-level cache — survives across refresh() calls within the same page session.
// This is intentionally separate from backend.ts's own ghCurrentUser() cache because
// tests replace ghCurrentUser with a spy, bypassing the backend's cache. Without this
// guard, each refresh() call would invoke the spy again and break the single-call test.
let _currentUser: string | null = null;

/** Reset identity cache. Call in tests between each test case. */
export function _resetTeamForTesting(): void {
  _currentUser = null;
}

/**
 * Composable for the Launchpad Team panel.
 * Aggregates colleagues' open PRs from all repos, detects file-level overlap
 * with the current user's WIP changes or open branches.
 * Each call returns a fresh reactive scope — no shared singleton.
 */
export function useLaunchpadTeam() {
  const teamActivity = ref<readonly TeamMemberActivity[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refresh(repos: WorkspaceRepo[]): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      // 1. Identity (cached)
      if (!_currentUser) _currentUser = await ghCurrentUser();
      const me = _currentUser;

      // 2. Fetch PRs — split into mine and colleagues'
      const allRepoPrs = await workspacePrsAll(repos);
      const flat: PrWithRepo[] = allRepoPrs.flatMap((r) =>
        r.prs.map((pr) => ({ ...pr, repoName: r.repoName, repoPath: r.repoPath }))
      );
      const myPrs = flat.filter((pr) => pr.author === me);
      const colleaguePrs = flat.filter((pr) => pr.author !== me);

      // 3. Collect my changed files from WIP
      const wipData = await workspaceWipAll(repos);
      let myFiles: string[] = wipData.flatMap((w) => w.changedFiles);
      let myContext: "wip" | "branch" = "wip";

      // 4. Branch fallback: if WIP is empty and I have open PRs, use their file lists
      if (myFiles.length === 0 && myPrs.length > 0) {
        const myPrFileLists = await concurrentMap(
          myPrs,
          (pr) => ghPrFiles(pr.repoPath, pr.number).catch(() => []),
          5,
        );
        myFiles = [...new Set(myPrFileLists.flat())];
        myContext = "branch";
      }

      // 5. Fetch file lists for all colleague PRs with concurrency limit
      const colleagueFileLists = await concurrentMap(
        colleaguePrs,
        (pr) => ghPrFiles(pr.repoPath, pr.number).catch(() => []),
        5,
      );

      // 6. Build TeamMemberActivity map
      const myFileSet = new Set(myFiles);
      const memberMap = new Map<
        string,
        { prs: PrWithRepo[]; overlappingPrs: OverlappingPr[] }
      >();
      for (let i = 0; i < colleaguePrs.length; i++) {
        const pr = colleaguePrs[i];
        const files = colleagueFileLists[i];
        const overlapping = files.filter((f) => myFileSet.has(f));
        const login = pr.author;
        if (!memberMap.has(login)) {
          memberMap.set(login, { prs: [], overlappingPrs: [] });
        }
        const member = memberMap.get(login)!;
        member.prs.push(pr);
        if (overlapping.length > 0) {
          member.overlappingPrs.push({ ...pr, overlappingFiles: overlapping, myContext });
        }
      }

      // 7. Sort PRs within each member by createdAt desc, then sort members
      teamActivity.value = Array.from(memberMap.entries())
        .map(([login, data]) => ({
          login,
          prs: data.prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          overlappingPrs: data.overlappingPrs,
        }))
        .sort((a, b) => {
          const aHas = a.overlappingPrs.length > 0 ? 0 : 1;
          const bHas = b.overlappingPrs.length > 0 ? 0 : 1;
          if (aHas !== bHas) return aHas - bHas;
          return a.login.localeCompare(b.login);
        });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  return { teamActivity, loading, error, refresh };
}
