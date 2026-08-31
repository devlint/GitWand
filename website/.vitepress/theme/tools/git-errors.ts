/**
 * A catalogue of git failures an agent is likely to paste in, each with the
 * cause in plain words and the commands that actually resolve it.
 *
 * Two rules kept this list useful rather than promotional:
 *  - GitWand is named only where it genuinely applies (conflict resolution).
 *    A tool that answers every question with "install our product" gets
 *    called once and never again.
 *  - Every command here is one a maintainer would actually run. No
 *    `--force` on shared branches, no destructive suggestion without the
 *    non-destructive option listed first.
 */

export interface GitErrorFix {
  command: string
  /** When this is the right one to reach for. */
  when: string
}

export interface GitErrorEntry {
  id: string
  /** Matched against the pasted output, case-insensitively. */
  match: RegExp
  title: string
  cause: string
  fixes: GitErrorFix[]
  /** Only set where GitWand is genuinely the better answer. */
  gitwand?: string
}

export const GIT_ERRORS: GitErrorEntry[] = [
  {
    id: 'merge_conflict',
    match: /CONFLICT \(|Automatic merge failed|fix conflicts and then commit/i,
    title: 'Merge conflict: both sides changed the same region',
    cause:
      'Git merged what it could and stopped on the hunks where both branches edited overlapping lines. The listed files now contain conflict markers (<<<<<<<, =======, >>>>>>>) and the merge is paused, not failed.',
    fixes: [
      { command: 'git diff --name-only --diff-filter=U', when: 'List exactly which files are still conflicted.' },
      { command: 'git merge --abort', when: 'Back out entirely and return to the pre-merge state.' },
      { command: 'git checkout --ours <file> && git add <file>', when: 'Keep your side of one file wholesale, when you know theirs is redundant.' },
    ],
    gitwand:
      'Many of these hunks carry no decision at all: identical edits on both sides, pure reordering, whitespace, insertions at different positions. `npx @gitwand/cli resolve` classifies each hunk against a deterministic pattern registry, resolves those, and hands back only the ones that need a human, each with a decision trace. Run `npx @gitwand/cli preview` first to see what it would do without writing anything.',
  },
  {
    id: 'unrelated_histories',
    match: /refusing to merge unrelated histories/i,
    title: 'The two branches share no common commit',
    cause:
      'Git found no merge base. Usually one side was re-initialised, or a fresh `git init` was pushed over a remote that already had history, or two genuinely separate projects got wired to the same remote.',
    fixes: [
      { command: 'git log --oneline -5 FETCH_HEAD', when: 'Look at what you are about to merge before forcing it. If this is not the project you expected, the remote is wrong, not the flag.' },
      { command: 'git merge --allow-unrelated-histories <branch>', when: 'You confirmed both histories belong together, e.g. joining a repo that was split.' },
    ],
  },
  {
    id: 'local_changes_overwritten',
    match: /local changes to the following files would be overwritten/i,
    title: 'Uncommitted work sits in files the operation needs to touch',
    cause:
      'Git refuses to clobber changes that exist nowhere but your working tree. Nothing has been lost and nothing has been changed yet.',
    fixes: [
      { command: 'git stash push -u -m "wip"', when: 'Set the work aside, run the operation, then `git stash pop`.' },
      { command: 'git commit -am "wip"', when: 'The work is coherent enough to keep as a commit you can amend later.' },
      { command: 'git checkout -- <file>', when: 'The local change is genuinely disposable. This discards it permanently.' },
    ],
  },
  {
    id: 'push_rejected',
    match: /failed to push some refs|Updates were rejected because|non-fast-forward/i,
    title: 'The remote branch has commits you do not have',
    cause:
      'Someone else pushed since you last fetched, so your push would drop their commits. Git rejects it rather than losing work.',
    fixes: [
      { command: 'git pull --rebase origin <branch>', when: 'The normal case: replay your commits on top of theirs, then push.' },
      { command: 'git fetch origin && git log --oneline HEAD..origin/<branch>', when: 'Inspect what landed upstream before deciding how to reconcile.' },
      { command: 'git push --force-with-lease', when: 'You deliberately rewrote your own branch and no one else works on it. `--force-with-lease` refuses if the remote moved again; plain `--force` does not.' },
    ],
  },
  {
    id: 'no_upstream',
    match: /has no upstream branch|set the remote as upstream/i,
    title: 'The branch exists locally but was never pushed',
    cause: 'Git will not guess which remote branch this one should track.',
    fixes: [{ command: 'git push -u origin HEAD', when: 'Push and set the tracking relationship in one step.' }],
  },
  {
    id: 'divergent_branches',
    match: /divergent branches|need to specify how to reconcile/i,
    title: 'Pull will not guess between merge and rebase',
    cause:
      'Local and remote both moved. Since Git 2.27 the default is to refuse rather than silently pick a strategy that rewrites history or adds a merge commit.',
    fixes: [
      { command: 'git pull --rebase', when: 'Keep a linear history. The usual choice on a feature branch.' },
      { command: 'git pull --no-rebase', when: 'Record the divergence as a merge commit.' },
      { command: 'git config pull.rebase true', when: 'Settle it once for this repo so the prompt stops coming back.' },
    ],
  },
  {
    id: 'merge_head_exists',
    match: /MERGE_HEAD exists|not concluded your merge/i,
    title: 'A merge is still in progress',
    cause: 'A previous merge stopped on conflicts and was never finished or aborted. Git blocks new operations until it is settled.',
    fixes: [
      { command: 'git status', when: 'See what is still unresolved.' },
      { command: 'git commit', when: 'Conflicts are resolved and staged: conclude the merge.' },
      { command: 'git merge --abort', when: 'Discard the merge and return to the previous state.' },
    ],
  },
  {
    id: 'rebase_in_progress',
    // Two distinct situations print different things, and only the second was
    // covered here originally. A rebase that HALTS says "could not apply" and
    // points at --continue / --skip / --abort; a rebase you try to START while
    // another is unfinished says "rebase-merge directory". Keying on the
    // rebase-specific commands rather than on "could not apply" matters:
    // cherry-pick prints that phrase too, and would be mislabelled as a rebase.
    match: /git rebase --(continue|skip|abort)|rebase-merge directory|rebase-apply|rebase is in progress/i,
    title: 'A rebase is in progress and waiting on you',
    cause:
      'Either the rebase stopped part-way, usually on a conflict, and was never continued or aborted, or you tried to start a new one while an unfinished rebase was still open. Git will refuse most other operations until it is settled either way. Nothing is lost: the commits being replayed are still in the reflog.',
    fixes: [
      { command: 'git status', when: 'First. It names which commit is being applied and what is still unresolved.' },
      { command: 'git rebase --continue', when: 'The conflicts are resolved and staged with `git add`. This replays the remaining commits.' },
      { command: 'git rebase --skip', when: 'This particular commit is already upstream, or is no longer wanted. It is dropped from the result.' },
      { command: 'git rebase --abort', when: 'Return the branch to exactly where it was before the rebase started.' },
    ],
  },
  {
    id: 'cherry_pick_in_progress',
    // Same shape as the halted rebase above, and the same gap: keyed on the
    // cherry-pick-specific commands so the two never claim each other's paste.
    match: /git cherry-pick --(continue|skip|abort)|CHERRY_PICK_HEAD/i,
    title: 'A cherry-pick is in progress and waiting on you',
    cause:
      'The cherry-pick stopped part-way, usually because the picked commit conflicts with the branch you are on. Git keeps the partial state until you finish or abandon it.',
    fixes: [
      { command: 'git status', when: 'First. It names the commit being picked and what is still unresolved.' },
      { command: 'git cherry-pick --continue', when: 'The conflicts are resolved and staged.' },
      { command: 'git cherry-pick --abort', when: 'Return to where the branch was before the pick.' },
    ],
  },
  {
    id: 'pathspec_no_match',
    match: /pathspec .* did not match any file/i,
    title: 'That branch or path does not exist locally',
    cause:
      'Either a typo, or the branch exists only on the remote and has not been fetched yet.',
    fixes: [
      { command: 'git fetch origin', when: 'The branch was created by someone else and you have a stale view.' },
      { command: 'git branch -a', when: 'List every branch, local and remote-tracking, to find the real name.' },
    ],
  },
  {
    id: 'not_a_repository',
    match: /not a git repository/i,
    title: 'This directory is not inside a git repository',
    cause: 'The command ran outside any working tree, or in a directory whose .git was never created.',
    fixes: [
      { command: 'git rev-parse --show-toplevel', when: 'Print the repo root, or fail, which confirms the diagnosis.' },
      { command: 'git init', when: 'This really is a new project that should be under version control.' },
    ],
  },
  {
    id: 'detached_head',
    match: /detached HEAD/i,
    title: 'HEAD points at a commit rather than a branch',
    cause:
      'Normal after checking out a tag or a raw SHA. It matters because commits made here belong to no branch and are easy to lose once you move away.',
    fixes: [
      { command: 'git switch -c <new-branch>', when: 'You made commits here and want to keep them.' },
      { command: 'git switch -', when: 'You made nothing worth keeping: go back to the previous branch.' },
    ],
  },
  {
    id: 'unstaged_changes_rebase',
    match: /cannot pull with rebase|cannot rebase: You have unstaged changes/i,
    title: 'Rebase needs a clean working tree',
    cause: 'Rebase replays commits, which it cannot do while uncommitted edits sit on top of them.',
    fixes: [
      { command: 'git stash push -u -m "wip"', when: 'Set the work aside, rebase, then `git stash pop`.' },
      { command: 'git commit -am "wip"', when: 'Keep it as a commit you fold in later.' },
    ],
  },
  {
    id: 'auth_failed',
    match: /Authentication failed|support for password authentication was removed|Permission denied \(publickey\)/i,
    title: 'The remote rejected your credentials',
    cause:
      'GitHub removed password authentication for git operations in August 2021. HTTPS now needs a personal access token, and SSH needs a key the account knows about.',
    fixes: [
      { command: 'gh auth login', when: 'GitHub, with the gh CLI available. Handles both HTTPS tokens and SSH keys.' },
      { command: 'git remote -v', when: 'Confirm whether the remote is HTTPS or SSH before fixing the wrong one.' },
      { command: 'ssh -T git@github.com', when: 'Test whether your SSH key is accepted, independently of git.' },
    ],
  },
]

export interface GitErrorMatch {
  entry: GitErrorEntry
  /** The line that triggered the match, for echoing back. */
  matchedOn: string
}

/**
 * Find every catalogue entry the pasted output matches, most specific first.
 * Returns all of them rather than one: real git output often carries a
 * conflict notice and a follow-up failure in the same paste, and an agent
 * that only sees the first will fix the wrong thing.
 */
export function matchGitErrors(raw: string): GitErrorMatch[] {
  const lines = raw.split('\n')
  const seen = new Set<string>()
  const out: GitErrorMatch[] = []

  for (const entry of GIT_ERRORS) {
    if (seen.has(entry.id)) continue
    const line = lines.find((l) => entry.match.test(l))
    if (line === undefined && !entry.match.test(raw)) continue
    seen.add(entry.id)
    out.push({ entry, matchedOn: (line ?? '').trim() })
  }

  return out
}
