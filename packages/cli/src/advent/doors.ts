/**
 * The 24 doors of the Git Advent Calendar. Source of truth for the copy.
 *
 * Imports nothing: this file is loaded by `node --experimental-strip-types`
 * and bundled by the website. No enums.
 *
 * The evidence behind each tip lives in the test fixture
 * `src/__tests__/fixtures/advent-evidence.ts`: it is not part of the build, so
 * it never reaches the npm package, the website bundle or the CLI's JSON output.
 */

export interface AdventDoor {
  day: number;
  /** Door title, e.g. "git log -L". */
  command: string;
  /** Reader's voice, no surrounding quotes. */
  problem: string;
  /** Runnable lines only, "\n"-separated. */
  snippet: string;
  /** Inline markup (`code`, **label**). */
  explanation: string;
  /** Inline markup (`code`, **label**). */
  tip?: string;
  /** Site path, e.g. "/blog/worktrees-step-by-step". */
  readMore?: string;
}

export const DOORS: readonly AdventDoor[] = [
  // ── Week 1 — Small gifts ──────────────────────────────────────────────
  {
    day: 1,
    command: "git switch -",
    problem: "I keep typing the name of the branch I was just on.",
    snippet: "git switch -",
    explanation:
      'Like `cd -` in your shell, `-` means "the branch I was on before". Run it again and you\'re back. It works with `git checkout -` and `git merge -` too, and `@{-1}` is the same idea when you need a revision.',
  },
  {
    day: 2,
    command: "git add -p",
    problem: "This file has two unrelated changes, and I only want to commit one.",
    snippet: "git add -p src/app.ts",
    explanation:
      "Git walks you through the file hunk by hunk: `y` to stage it, `n` to skip, `s` to split a hunk into smaller ones, `e` to edit it by hand. One messy working tree, two clean commits.",
    tip: "In GitWand, every hunk in the diff has a **Stage hunk** button. To go finer than a hunk, click the lines you want, then **Stage (n)**.",
  },
  {
    day: 3,
    command: "git diff --word-diff",
    problem: "One word changed in a long line, and the diff shows the whole line red then green.",
    snippet: "git diff --word-diff",
    explanation:
      "Instead of whole lines, git marks what changed inside the line: `[-removed-]{+added+}`. It's perfect for prose, config values, and long lines generally. Use `--color-words` for colours only.",
    tip: "GitWand does this automatically. Paired changed lines get word-level highlights in the diff, the file history and the merge editor, with nothing to turn on.",
  },
  {
    day: 4,
    command: "git stash push --staged",
    problem: "I want to stash some of my changes, not everything.",
    snippet: [
      "git stash push --staged",
      "git stash push -- path/to/file",
      "git stash push -p",
    ].join("\n"),
    explanation:
      "`--staged` (git 2.35+) stashes only what's in the index. A pathspec after `--` stashes only those files, and `-p` lets you pick hunks, like `add -p`.",
    tip: "GitWand's stash always takes everything, untracked files included, so this one is for the terminal. What GitWand adds is the message: in the **Stash Manager**, **Suggest a message with AI** writes it from your diff.",
  },
  {
    day: 5,
    command: "git clean -n",
    problem:
      "I want to delete untracked files, but I'm scared of what `git clean -f` will take with it.",
    snippet: ["git clean -nd", "git clean -i"].join("\n"),
    explanation:
      "`-n` is a dry run: it lists what would be deleted (`-d` includes directories, `-x` includes ignored files too). `-i` is interactive: pick by number, pattern or one by one.",
    tip: "When you discard untracked files in GitWand, it takes a **Time Machine** snapshot first (untracked files included), so a wrong click can be undone.",
  },
  {
    day: 6,
    command: "git config core.hooksPath",
    problem: "Our git hooks live in each dev's `.git/hooks`, so nobody has the same ones.",
    snippet: "git config core.hooksPath .githooks",
    explanation:
      "Point git at a hooks folder that's committed in the repo (git 2.9+). Everyone who runs this one line gets the same `pre-commit`, `commit-msg` and other hooks, with no extra tooling.",
    tip: "A good first hook: `npx @gitwand/cli scan --staged --strict` blocks a commit that contains something that looks like a secret. The GitWand app runs the same check before every commit (**Potential secrets in this commit**).",
    readMore: "/blog/v3-5-pr-review-2-secrets-scanner",
  },

  // ── Week 2 — Christmas investigation ──────────────────────────────────
  {
    day: 7,
    command: "git log -S",
    problem: "This function call disappeared from the codebase. When?",
    snippet: ['git log -S "retryWithBackoff" --oneline', 'git log -G "retry\\w+"'].join("\n"),
    explanation:
      'The "pickaxe". `-S` finds commits where the number of occurrences of that string changed, in other words where it was added or removed. `-G` takes a regex and matches any diff line. Add `-p` to see the diffs.',
    tip: "In GitWand, open **File history** and type in the search box (**Search string or regex…**). It runs the same pickaxe search, as a literal string or as a regex, following renames.",
  },
  {
    day: 8,
    command: "git log -L",
    problem: "Who broke this function, and when?",
    snippet: ["git log -L :parseHunk:src/parse.ts", "git log -L 40,60:src/parse.ts"].join("\n"),
    explanation:
      "Shows every commit that touched that function (or that line range), with the diff trimmed to just those lines. It's the history of a piece of code, not of a whole file.",
    tip: "In GitWand's blame view, each block has **Show history for these lines**, which is `git log -L` on that range in one click.",
  },
  {
    day: 9,
    command: "git blame -w -C -C -C",
    problem:
      "Blame says I wrote this, but I only re-indented it, or moved it from another file.",
    snippet: "git blame -w -C -C -C src/parse.ts",
    explanation:
      "`-w` ignores whitespace changes. Each `-C` looks further for lines copied or moved from elsewhere: first from files changed in the same commit, then from the commit that created the file, then from any commit. Blame then lands on the real author.",
    tip: "GitWand's blame doesn't follow copies yet. On any blame block, though, **Why did this change?** asks the AI to explain the commit behind it.",
  },
  {
    day: 10,
    command: "git blame --ignore-revs-file",
    problem:
      "We ran Prettier on the whole repo, and now blame points at that commit for every line.",
    snippet: [
      'echo "<sha-of-the-format-commit>" >> .git-blame-ignore-revs',
      "git config blame.ignoreRevsFile .git-blame-ignore-revs",
    ].join("\n"),
    explanation:
      "Blame skips the listed commits and looks through them to the previous author. Commit the file. GitHub's blame view honours `.git-blame-ignore-revs` too.",
  },
  {
    day: 11,
    command: "git bisect run",
    problem: "It worked last month. Somewhere in 300 commits, something broke.",
    snippet: ["git bisect start HEAD v3.12.0", "git bisect run npm test", "git bisect reset"].join(
      "\n",
    ),
    explanation:
      'Git binary-searches the range and runs your script at each step: exit 0 means good, 1–127 means bad, 125 means "skip this one". About nine test runs for 300 commits, and you can go get a coffee.',
  },
  {
    day: 12,
    command: "git reflog",
    problem: "I did a `reset --hard` and my commits are gone.",
    snippet: ["git reflog", "git branch rescue HEAD@{2}"].join("\n"),
    explanation:
      'Git keeps a local log of everywhere `HEAD` has been. Commits no branch points to stay recoverable for 30 days by default. "Lost" commits are almost never lost: find them in the reflog and put a branch on them.',
    tip: "GitWand's undo button opens the **Operation history**, which is built from the reflog. **Rewind** jumps back to any point, and **Time Machine** adds snapshots of uncommitted work on top.",
  },

  // ── Week 3 — Rewriting history ────────────────────────────────────────
  {
    day: 13,
    command: "git commit --fixup + --autosquash",
    problem: "I found a typo in a commit three commits back.",
    snippet: ["git commit --fixup=<sha>", "git rebase -i --autosquash <sha>~"].join("\n"),
    explanation:
      "`--fixup` creates a commit named `fixup! <original message>`. `--autosquash` moves it under its target and marks it `fixup` in the rebase todo list, so you just save. Set `rebase.autoSquash true` and you can drop the flag.",
    tip: "GitWand finds the `<sha>` for you. Right-click a changed file → **Absorb**. It blames each hunk to find the commit that owns those lines, then creates the fixup commit. Squash it later from the interactive rebase editor.",
  },
  {
    day: 14,
    command: "git range-diff",
    problem: "I rebased my branch. What actually changed, apart from the base?",
    snippet: "git range-diff @{u}...@",
    explanation:
      "It compares two versions of a series of commits, commit by commit: which ones changed, how, and which ones appeared or disappeared. Run it before a force push to see exactly what you're about to overwrite.",
  },
  {
    day: 15,
    command: "git push --force-with-lease --force-if-includes",
    problem: "I force-pushed and wiped my teammate's commit.",
    snippet: "git push --force-with-lease --force-if-includes",
    explanation:
      "`--force-with-lease` refuses to push if the remote moved since you last fetched. `--force-if-includes` (git 2.30+) closes the gap a background fetch opens: the remote tip must also be part of your own history. Set `push.useForceIfIncludes true` once.",
    tip: "GitWand's **Force push** never sends a bare `--force`. It uses `--force-with-lease`, pinned to the exact remote commit it showed you, and asks for confirmation if remote commits would be lost.",
  },
  {
    day: 16,
    command: "git worktree",
    problem: "Urgent hotfix, but I'm halfway through a feature and don't want to stash.",
    snippet: "git worktree add ../hotfix -b hotfix origin/main",
    explanation:
      "It's a second checkout of the same repo in another folder, sharing the same history and objects. Fix, commit and push there, then `git worktree remove ../hotfix`. Your feature branch never moved.",
    tip: "GitWand has a **Worktrees** manager (create, prune, repair). **New AI task** uses one to give a coding agent its own isolated checkout.",
    readMore: "/blog/worktrees-step-by-step",
  },
  {
    day: 17,
    command: "git rebase --update-refs",
    problem:
      "I stack branches (`feat-1` → `feat-2` → `feat-3`), and rebasing the bottom one breaks the others.",
    snippet: "git rebase -i --update-refs main",
    explanation:
      "Git 2.38+. When you rebase the top branch, every branch pointing into the rebased commits is moved along with them. Stacked PRs stay stacked. Set `rebase.updateRefs true` to make it the default.",
  },
  {
    day: 18,
    command: "Splitting a commit",
    problem: "This commit does two things. It should be two commits.",
    snippet: [
      'git rebase -i <sha>~     # mark the commit as "edit"',
      "git reset HEAD^",
      "git add -p && git commit # first half",
      'git commit -am "..."     # second half',
      "git rebase --continue",
    ].join("\n"),
    explanation:
      "`edit` stops the rebase on that commit, and `reset HEAD^` un-commits it while keeping the changes. Then you rebuild it as two commits with `add -p` (day 2).",
    tip: "In GitWand, right-click the commit → **Split commit…**, pick the hunks for the first commit, and the rest becomes the second.",
    readMore: "/blog/split-commit-by-hunks",
  },

  // ── Week 4 — The magic of conflicts ───────────────────────────────────
  {
    day: 19,
    command: "merge.conflictStyle zdiff3",
    problem:
      "Conflict markers show mine and theirs, but not what the code looked like before either of us touched it.",
    snippet: "git config --global merge.conflictStyle zdiff3",
    explanation:
      "It adds a third section, `||||||| base`, with the common ancestor. Seeing what each side changed makes most conflicts obvious. `zdiff3` (git 2.35+) also trims lines both sides agree on.",
    tip: "GitWand's merge editor shows the **Base** whenever it's there. With the default style it rebuilds it from the git index (**Common-ancestor base recovered from the git index**), so it works whatever your config.",
    readMore: "/blog/reading-git-conflict-markers",
  },
  {
    day: 20,
    command: "diff.algorithm histogram",
    problem: "The diff matched up all the closing braces and turned a small change into a mess.",
    snippet: "git config --global diff.algorithm histogram",
    explanation:
      "The default (Myers) produces the shortest diff, not always the most readable one. `histogram` anchors on rare, distinctive lines, so moved blocks and functions come out cleaner. Fewer messy diffs also means fewer confusing conflicts.",
    tip: "GitWand's diffs respect your `diff.algorithm`, and the blame view lets you switch algorithm on the fly.",
  },
  {
    day: 21,
    command: "git checkout --conflict=zdiff3",
    problem: "I botched a conflict resolution in one file. I want the conflict back.",
    snippet: "git checkout --conflict=zdiff3 -- src/app.ts",
    explanation:
      "As long as the merge isn't committed, git still has all three versions in the index. This rewrites the file with fresh conflict markers, in whichever style you ask for. Do-overs allowed. `git restore --merge src/app.ts` does the same.",
    tip: "If a file is marked as conflicted but has no markers left, GitWand's merge editor offers **Reconstruct conflict**, which rebuilds it from those same three index versions.",
  },
  {
    day: 22,
    command: "git merge-tree --write-tree",
    problem: "Will this merge conflict? I'd like to know before touching my working tree.",
    snippet: "git merge-tree --write-tree --name-only main feature",
    explanation:
      "Git 2.38+. It runs a real merge in memory and prints the resulting tree and any conflicting files, without touching your checkout or index. Exit code 1 means conflicts, which makes it handy in CI.",
    tip: "In GitWand's branch list, **Preview merge** does the same dry run and also tells you how much GitWand can auto-resolve (**Clean merge**, **100 % auto-resolvable**, or **Conflicts to review**). From a terminal: `npx @gitwand/cli preview --branch=feature`.",
  },
  {
    day: 23,
    command: "Merge drivers in .gitattributes",
    problem:
      "Every merge conflicts on `CHANGELOG.md`, because both branches added a line at the top.",
    snippet: ["# .gitattributes", "CHANGELOG.md merge=union"].join("\n"),
    explanation:
      'The built-in `union` driver keeps both sides\' lines instead of writing conflict markers. That\'s great for append-only files (check the order afterwards). You can also define your own driver with `git config merge.<name>.driver "<command>"` for any file type.',
    tip: "For lockfiles, don't keep both sides: regenerate the file. GitWand has dedicated resolvers for npm, pnpm, yarn and Cargo lockfiles, as well as for JSON, YAML and a few other formats.",
    readMore: "/blog/lockfile-conflicts-by-ecosystem",
  },
  {
    day: 24,
    command: "git rerere",
    problem: "I resolve the same conflict every time I rebase this branch.",
    snippet: "git config --global rerere.enabled true",
    explanation:
      "Reuse recorded resolution. Once it's enabled, git remembers how you resolved each conflict and replays it automatically the next time the same conflict shows up. `git rerere diff` shows what it recorded, and `git rerere forget <file>` drops a bad one.",
    tip: "rerere remembers your resolutions. GitWand tries to resolve conflicts before you even start: whitespace-only, same change on both sides, non-overlapping edits, lockfiles… Each fix comes with a confidence score. For the ones it can't solve, it offers **Remember this resolution for next time?**",
    readMore: "/fix/git-rerere",
  },
];
