import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import type { PullRequest } from "../utils/backend";
import type { ForgeProvider } from "./forge/types";

export interface UseBranchPrSearchOptions {
  /** Current repo path, passed through to `forge.getPR`. */
  cwd: Ref<string>;
  /** The branch popover's filter input value (shared with plain name search). */
  filterText: Ref<string>;
  /** The PR panel's currently-loaded (paginated) PR list. */
  prs: Ref<PullRequest[]>;
  /** The active forge provider (GitHub/GitLab/Bitbucket/Azure). */
  forge: Ref<ForgeProvider>;
  /** Debounce before falling back to a network fetch on a cache miss. */
  debounceMs?: number;
}

export interface UseBranchPrSearchResult {
  /** The typed PR number when `filterText` is exactly `#<digits>`, else null. */
  prNumberQuery: ComputedRef<number | null>;
  /** True while resolving a cache-miss query via `forge.getPR`. */
  lookupLoading: Ref<boolean>;
  /** The cached PR for a given branch name, or null. Strips `origin/` for remote branches. */
  prFor: (branchName: string, isRemote: boolean) => PullRequest | null;
  /** Whether `branchName` is the branch resolved for the current PR-number query. */
  matchesResolvedBranch: (branchName: string, isRemote: boolean) => boolean;
}

function stripRemotePrefix(name: string, isRemote: boolean): string | null {
  if (isRemote) {
    if (!name.startsWith("origin/")) return null;
    return name.slice(7);
  }
  return name;
}

/**
 * Resolves a `#<number>` branch-filter query to the PR's head branch name,
 * cache-first against the PR panel's loaded list, falling back to a single
 * debounced `forge.getPR` call for PRs outside the currently-loaded page.
 */
export function useBranchPrSearch(opts: UseBranchPrSearchOptions): UseBranchPrSearchResult {
  const { cwd, filterText, prs, forge, debounceMs = 350 } = opts;

  const prNumberQuery = computed<number | null>(() => {
    const match = /^#(\d+)$/.exec(filterText.value.trim());
    return match ? Number(match[1]) : null;
  });

  const resolvedBranchName = ref<string | null>(null);
  const lookupLoading = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  watch(prNumberQuery, (n) => {
    if (timer) clearTimeout(timer);
    resolvedBranchName.value = null;
    lookupLoading.value = false;
    if (n === null) return;

    const cached = prs.value.find((pr) => pr.number === n);
    if (cached) {
      resolvedBranchName.value = cached.branch;
      return;
    }

    lookupLoading.value = true;
    timer = setTimeout(async () => {
      try {
        const detail = await forge.value.getPR(cwd.value, n);
        // Stale guard: the user may have kept typing while this was in flight.
        if (prNumberQuery.value !== n) return;
        resolvedBranchName.value = detail.branch;
      } catch {
        // Leave resolvedBranchName null — callers treat that as "not found".
      } finally {
        if (prNumberQuery.value === n) lookupLoading.value = false;
      }
    }, debounceMs);
  });

  const byBranch = computed(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of prs.value) map.set(pr.branch, pr);
    return map;
  });

  function prFor(branchName: string, isRemote: boolean): PullRequest | null {
    const stripped = stripRemotePrefix(branchName, isRemote);
    if (stripped === null) return null;
    return byBranch.value.get(stripped) ?? null;
  }

  function matchesResolvedBranch(branchName: string, isRemote: boolean): boolean {
    if (!resolvedBranchName.value) return false;
    const stripped = stripRemotePrefix(branchName, isRemote);
    return stripped !== null && stripped === resolvedBranchName.value;
  }

  return { prNumberQuery, lookupLoading, prFor, matchesResolvedBranch };
}
