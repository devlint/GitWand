import type { RepoFileEntry } from "../composables/useGitRepo";

/**
 * The git steps that throw away every change in a set of sidebar entries,
 * in the order the caller must run them:
 *
 *   1. `unstage`  → `git reset HEAD -- <paths>`
 *   2. `checkout` → `git checkout -- <paths>` (restore from the index)
 *   3. `clean`    → `git clean -f -- <paths>` (delete untracked files)
 */
export interface DiscardPlan {
  unstage: string[];
  checkout: string[];
  clean: string[];
}

/**
 * Plan a discard. A plain `git checkout -- <path>` restores the worktree from
 * the index, so a staged change would survive it: staged entries are unstaged
 * first. Once unstaged, a staged addition is an untracked file, and a staged
 * rename is an untracked new path plus a deleted old path.
 *
 * A path that ends up untracked is never also passed to `checkout`: one
 * unmatched pathspec makes git refuse the whole checkout, which would leave
 * every other file in the batch untouched.
 */
export function planDiscard(entries: readonly RepoFileEntry[]): DiscardPlan {
  const unstage = new Set<string>();
  const checkout = new Set<string>();
  const clean = new Set<string>();

  for (const e of entries) {
    if (e.section === "staged") {
      unstage.add(e.path);
      if (e.status === "renamed" && e.oldPath) {
        unstage.add(e.oldPath);
        checkout.add(e.oldPath);
        clean.add(e.path);
      } else if (e.status === "added" || e.status === "renamed") {
        clean.add(e.path);
      } else {
        checkout.add(e.path);
      }
    } else if (e.section === "unstaged") {
      checkout.add(e.path);
    } else if (e.section === "untracked") {
      clean.add(e.path);
    }
  }

  return {
    unstage: [...unstage],
    checkout: [...checkout].filter((p) => !clean.has(p)),
    clean: [...clean],
  };
}

/**
 * The entries a sidebar discard targets. A partially staged file has two
 * entries under one path — one `staged`, one `unstaged` — so matching on path
 * alone would drag the staged entry into a "Changes" discard and wipe the
 * index too. `sectionKey` is the sidebar's display section: `changes` covers
 * `unstaged` + `untracked`, `staged` covers `staged`, and `all` covers every
 * entry.
 */
export function selectDiscardEntries(
  entries: readonly RepoFileEntry[],
  sectionKey: string,
  paths: readonly string[],
): RepoFileEntry[] {
  if (sectionKey === "all") return [...entries];
  const wanted = new Set(paths);
  return entries.filter((e) => {
    if (!wanted.has(e.path)) return false;
    if (sectionKey === "changes") return e.section === "unstaged" || e.section === "untracked";
    return e.section === sectionKey;
  });
}

/** What a discard confirmation has to tell the user before it runs. */
export interface DiscardSummary {
  kind: "staged" | "changes" | "all";
  /** Distinct paths touched (a partially staged file counts once). */
  fileCount: number;
  /** Staged entries that will be thrown away. */
  stagedCount: number;
  /**
   * Staged-section discard only: files that also have unstaged changes.
   * Discarding the staged entry restores the file from HEAD, so those
   * unstaged changes are lost too.
   */
  alsoUnstagedCount: number;
}

export function summarizeDiscard(
  entries: readonly RepoFileEntry[],
  sectionKey: string,
  paths: readonly string[],
): DiscardSummary {
  const kind = sectionKey === "staged" || sectionKey === "changes" ? sectionKey : "all";
  const targets = selectDiscardEntries(entries, sectionKey, paths);
  const staged = targets.filter((e) => e.section === "staged");
  const unstagedPaths = new Set(
    entries.filter((e) => e.section === "unstaged").map((e) => e.path),
  );
  return {
    kind,
    fileCount: new Set(targets.map((e) => e.path)).size,
    stagedCount: staged.length,
    alsoUnstagedCount: kind === "staged" ? staged.filter((e) => unstagedPaths.has(e.path)).length : 0,
  };
}
