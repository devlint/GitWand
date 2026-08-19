/**
 * repoStats.ts
 *
 * v3.7.0 review-round fix (Task 1, finding #1, CRITICAL) — pure, Vue-free,
 * backend-free (type-only import) module holding `useGitRepo.ts`'s
 * `repoStats` computed body, lifted out VERBATIM so it can be memoized and
 * unit-tested. `App.vue` has no test harness of its own, so this module is
 * the only executable proof this fix works.
 *
 * Root cause this fixes: `status.value = await getGitStatus(...)` assigns a
 * BRAND NEW object on every 2s poll tick, even when nothing changed. The old
 * `repoStats` computed always `return`ed a fresh object literal, so Vue's
 * `hasChanged(new, old)` (`!Object.is`) always saw a "change" and notified
 * every subscriber on every poll tick, whether or not the staged set (or
 * anything else) actually changed. `createRepoStatsMemo` hands back the
 * PREVIOUS object reference whenever the freshly computed stats are
 * field-for-field identical to the last call, which stops a Vue `computed`
 * wrapping it from notifying (and every `watch` on it from re-firing) on a
 * routine no-op poll.
 */
import type { GitStatus } from "./backend";

export interface RepoStats {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

export const EMPTY_REPO_STATS: RepoStats = Object.freeze({
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  added: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
});

/** Body moved VERBATIM out of useGitRepo.ts (fileStates precedence included). */
export function computeRepoStats(status: GitStatus | null): RepoStats {
  if (!status) return EMPTY_REPO_STATS;
  const s = status;

  const fileStates = new Map<string, "added" | "modified" | "deleted" | "renamed">();

  for (const path of s.untracked) {
    fileStates.set(path, "added");
  }
  for (const path of s.conflicted) {
    fileStates.set(path, "modified");
  }
  for (const f of s.staged) {
    if (f.status === "added") fileStates.set(f.path, "added");
    else if (f.status === "deleted") fileStates.set(f.path, "deleted");
    else if (f.status === "renamed") fileStates.set(f.path, "renamed");
    else fileStates.set(f.path, "modified");
  }
  for (const f of s.unstaged) {
    const current = fileStates.get(f.path);
    if (f.status === "deleted") fileStates.set(f.path, "deleted");
    else if (f.status === "added") fileStates.set(f.path, "added");
    else if (!current) fileStates.set(f.path, "modified");
  }

  let added = 0,
    modified = 0,
    deleted = 0,
    renamed = 0;
  for (const state of fileStates.values()) {
    if (state === "added") added++;
    else if (state === "modified") modified++;
    else if (state === "deleted") deleted++;
    else if (state === "renamed") renamed++;
  }

  return {
    staged: s.staged.length,
    unstaged: s.unstaged.length,
    untracked: s.untracked.length,
    conflicted: s.conflicted.length,
    added,
    modified,
    deleted,
    renamed,
  };
}

/** Shallow field-by-field equality over the 8 numeric fields. */
export function sameRepoStats(a: RepoStats, b: RepoStats): boolean {
  return (
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.untracked === b.untracked &&
    a.conflicted === b.conflicted &&
    a.added === b.added &&
    a.modified === b.modified &&
    a.deleted === b.deleted &&
    a.renamed === b.renamed
  );
}

/**
 * Returns a memoizing view over computeRepoStats: it hands back the PREVIOUS
 * object reference whenever the freshly computed stats are field-for-field
 * identical. That reference stability is what stops a Vue `computed` from
 * notifying (and every `watch` on it from re-firing) on a routine status poll
 * that changed nothing.
 */
export function createRepoStatsMemo(): (status: GitStatus | null) => RepoStats {
  let previous: RepoStats | null = null;
  return (status: GitStatus | null): RepoStats => {
    const next = computeRepoStats(status);
    if (previous && sameRepoStats(previous, next)) {
      return previous;
    }
    previous = next;
    return next;
  };
}

/**
 * Primitive identity of the staged SET (paths + statuses), safe to `watch`
 * directly. Fires on files entering/leaving the index or changing status,
 * including unstage-A + stage-B which a bare staged COUNT misses. It cannot
 * see a content-only restage of an already-staged file: `git status` carries
 * no content hash. Consumers that need that must recompute at commit time.
 *
 * Reordering is deliberately NOT normalized: git's own status output order is
 * stable for an unchanged working tree, so this is safe.
 */
export function stagedFingerprintOf(status: GitStatus | null): string {
  if (!status) return "";
  return status.staged.map((f) => `${f.status}:${f.path}`).join("\n");
}
