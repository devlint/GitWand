---
title: "Lockfile conflicts: package-lock, pnpm-lock, yarn.lock, composer.lock, Cargo.lock — the right move for each"
description: "Five package managers, five different answers to the same conflict. What each one's own documentation says to do, the command that does it, the traps (starting before the manifest is resolved, an immutable install in CI, a command that updates more than the merge did), and what GitWand's lockfile handling actually does and does not do."
date: 2026-11-12
head:
  - - meta
    - property: og:title
      content: "Lockfile conflicts: the right move for npm, pnpm, Yarn, Composer and Cargo"
  - - meta
    - property: og:description
      content: "What each package manager's documentation says to do about a conflicted lockfile, the traps that turn a clean merge into a wrong dependency tree, and what GitWand's resolvers and regeneration plan really do."
---

# Lockfile conflicts: package-lock, pnpm-lock, yarn.lock, composer.lock, Cargo.lock — the right move for each

A conflicted lockfile is the one merge conflict almost nobody reads. It is long, it is machine-written, and the hunks are made of hashes. So it gets the reflex treatment: take one side, reinstall, commit. Sometimes that is exactly right. Sometimes it is right for npm and wrong for Composer. And sometimes the reinstall quietly changes more than the merge did.

This guide goes ecosystem by ecosystem: what the package manager's own documentation says to do, the command, and the traps. Every recommendation below links to the official page it comes from. The last part describes what GitWand does with these files, checked against `packages/core` and `packages/cli` as they ship in 3.13.1, including the places where it does less than you might assume.

If you only use npm, the shorter [package-lock.json merge conflict](/fix/package-lock-json-merge-conflict) page covers that case and how to make lockfile conflicts rarer. If you want to know where lockfiles sit among the conflicts GitWand resolves on its own, see entry 10 of [the trivial-conflicts taxonomy](/blog/trivial-conflicts-taxonomy).

---

## The rule that applies to all five

A lockfile is the output of a resolver run on a manifest: `package.json`, `composer.json` or `Cargo.toml`. Whatever you do to the lockfile, the package manager will rebuild or check it against the manifest. So:

1. **Resolve the manifest first, by hand, and check it.** If you regenerate the lockfile from a manifest that still has a mistake in it, the mistake ends up in the lockfile too, where nobody will look for it.
2. **Then let the package manager produce the lockfile.** Do not edit hunks in it yourself. Two valid halves can be stitched into a file that parses but describes a dependency tree the resolver would never have produced.
3. **Then read the diff of the lockfile against the target branch.** You are looking for packages that changed version even though neither branch asked for it.

The ecosystems differ on step 2: some package managers merge the conflicted file themselves, others expect you to start from one side.

---

## npm — `package-lock.json`

**Why it conflicts.** Since lockfile v2, `package-lock.json` keeps one entry per installed path under `"packages"`. Adding one dependency can insert or move entries anywhere in the file, so two branches that each add an unrelated package often conflict in several places.

**What the documentation says.** The section that covers this is in the older npm 6 docs, under [Resolving lockfile conflicts](https://docs.npmjs.com/cli/v6/configuring-npm/package-locks/). It says that from npm 5.7.0, you fix any `package.json` conflicts by hand and then run `npm install [--package-lock-only]` again; npm resolves the conflicts in the lockfile and writes a merged one. The current [package-lock.json page](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json) no longer has that section, so check the result rather than relying on it.

```bash
# 1. resolve package.json by hand, then:
npm install --package-lock-only
git add package.json package-lock.json
```

According to the [npm install docs](https://docs.npmjs.com/cli/v11/commands/npm-install), `--package-lock-only` only updates `package-lock.json`, without checking `node_modules` or downloading dependencies. That makes it the cheapest way to answer the question, and it does not touch your working install.

**Traps.**

- Running it while `package.json` still has markers. If the manifest does not parse, npm cannot do anything useful, so fix it first.
- `npm ci` in CI is the check, not the fix. It refuses a lockfile that does not match `package.json`, which is the behaviour you want after a merge.
- Taking `--theirs` before reinstalling drops anything that existed only in your side of the lockfile, such as a transitive version you had pinned. The [npm fix page](/fix/package-lock-json-merge-conflict) explains that case in detail.

## pnpm — `pnpm-lock.yaml`

**Why it conflicts.** Same cause as npm, in YAML: the `importers`, `packages` and `snapshots` sections all change when a dependency is added, so the conflicts are spread across the file.

**What the documentation says.** pnpm's [Working with Git](https://pnpm.io/git) page is the most direct of the five. pnpm can resolve merge conflicts in `pnpm-lock.yaml` itself: run `pnpm install` and commit. If both sides of the conflict are valid lockfiles, pnpm merges them; otherwise it fails with the parse error. The page adds that you should review the result before committing.

```bash
# 1. resolve every conflicted package.json (root and workspace packages)
pnpm install
git add pnpm-lock.yaml
```

**Traps.**

- **CI and frozen lockfiles.** According to the [pnpm install docs](https://pnpm.io/cli/install), in CI the install fails if a lockfile is present but needs an update. That is good as a check, but it means the merge has to be fixed on a machine where updating the lockfile is allowed.
- **Workspaces have more than one manifest.** In a pnpm monorepo, a conflict in `packages/foo/package.json` matters as much as one in the root `package.json`. Resolve all of them before running the install.
- **If you keep getting these conflicts**, the same page describes Git branch lockfiles (one lockfile per branch, merged when the branch is merged). That changes when the conflict happens; it does not make it go away.

## Yarn — `yarn.lock`

There are two Yarns, and they handle this differently.

**Yarn 2 and later (Berry).** `yarn install` handles conflict markers in `yarn.lock` itself. The [error-code reference](https://yarnpkg.com/advanced/error-codes) describes the process. `YN0049 AUTOMERGE_REQUIRED` is reported when markers are found. Yarn takes the lockfile from the pulled branch, adds the information from the local branch, and runs the install again. `YN0048 AUTOMERGE_SUCCESS` means it worked. To know which two versions to merge, Yarn reads `MERGE_HEAD` or `REBASE_HEAD` (`YN0083`), so this works inside a merge or a rebase, not on a file you copied somewhere else.

```bash
# 1. resolve package.json by hand, then:
yarn install
git add yarn.lock
```

**Traps.**

- `yarn install --immutable` refuses to fix the conflict (`YN0047 AUTOMERGE_IMMUTABLE`): it is not allowed to edit any file. Run the plain install locally and commit the result.
- If one branch still has a Yarn 1 lockfile, the merge fails to parse (`YN0046`), because the v1 format is not YAML. The documented fix for that case is `git checkout --theirs yarn.lock` followed by `yarn install`.
- `--mode=update-lockfile` is not a conflict tool. According to the [install docs](https://yarnpkg.com/cli/install), it skips the link step and only fetches packages missing from the lockfile. It is meant for bots like Renovate or Dependabot. It is cheaper than a full install, and GitWand uses it (see below), but it is not the documented way to resolve a conflict.

**Yarn 1 (Classic).** The [yarn.lock page](https://classic.yarnpkg.com/lang/en/docs/yarn-lock/) only says not to edit the file by hand and to let Yarn handle it. Neither it nor the [install page](https://classic.yarnpkg.com/lang/en/docs/cli/install/) describes how to resolve conflicts. The usual approach is to take one side, run `yarn install` so it adds what the manifest needs, and check the diff. Treat that as common practice, not documented behaviour.

## Composer — `composer.lock`

**Why it conflicts, and why it is different.** On top of the per-package entries, `composer.lock` has a `content-hash` of `composer.json`. Any change to the manifest on both branches makes that line conflict, even if the packages do not.

**What the documentation says.** Composer has a whole page on this, [Resolving merge conflicts](https://getcomposer.org/doc/articles/resolving-merge-conflicts.md), and it differs from the JavaScript managers: Composer does not merge the lockfile for you. The procedure is:

1. Accept `composer.json` **and** `composer.lock` from one branch, preferably the one with more changes.
2. Re-apply the other branch's changes with Composer itself, for example `composer require vendor/package` for a package it added.
3. Validate before committing: `composer validate` and `composer install --dry-run`.

```bash
git checkout --theirs composer.json composer.lock   # the branch with more changes
composer require vendor/added-on-our-side            # replay the other side's changes
composer validate && composer install --dry-run
```

The same page states the cost plainly: the exact versions the other branch had locked for its new packages are lost, because `require` resolves them again.

**The trivial case.** If the only conflict is the `content-hash`, the page says `composer update --lock` may be enough. According to the [CLI reference](https://getcomposer.org/doc/03-cli.md), `--lock` overwrites the lock file hash without updating package versions.

**Traps.**

- Using `composer update` without arguments to fix the merge. That updates every package within its constraints, which is a dependency upgrade, not a conflict resolution.
- Assuming `update --lock` takes care of packages the other branch added. The documentation only presents it as a hash refresh. Use `require` for new packages.

## Cargo — `Cargo.lock`

**Why it conflicts.** Each `[[package]]` block is one crate version, with its checksum and dependency list. Two branches that add crates, or that bump a shared one differently, touch neighbouring blocks.

**What the documentation says.** The [Cargo FAQ](https://doc.rust-lang.org/cargo/faq.html) suggests resetting all of "your" changes to the lockfile, fixing the other conflicts in the branch, and then running any Cargo command (such as `cargo tree` or `cargo check`). Cargo then adds what your side needs to the lockfile, starting from what the other branch locked.

```bash
# 1. resolve Cargo.toml by hand (and every workspace member's Cargo.toml)
git checkout --theirs Cargo.lock     # "reset yours": keep the other branch's lock
cargo tree > /dev/null               # any cargo command updates the lock for your additions
git diff --stat HEAD -- Cargo.lock
```

During a merge, "yours" means `HEAD`, so you keep `--theirs`. During a rebase the two are swapped; [Reading a Git conflict marker](/blog/reading-git-conflict-markers) explains why.

**Traps.**

- **`cargo generate-lockfile` is not a conflict tool.** Its [documentation](https://doc.rust-lang.org/cargo/commands/cargo-generate-lockfile.html) says that if a lockfile already exists, it is rebuilt with the latest available version of every package. That changes every crate that has a newer compatible release, which is far more than the merge did.
- **Plain `cargo update` does the same.** Without a package argument it updates all dependencies. If you want a command, [`cargo update --workspace`](https://doc.rust-lang.org/cargo/commands/cargo-update.html) is the narrow one: it updates the workspace's own packages, and other packages only if they are not in the lockfile yet. The documentation describes it as useful for updating `Cargo.lock` after changing versions in `Cargo.toml`. `--dry-run` shows what would change without writing anything.
- **`--locked` in CI** errors if Cargo would need to change the lockfile. That is the check you want after the merge.

---

## Summary

| Lockfile | Does the tool merge the conflicted file itself? | Documented move | The command to avoid for this |
|---|---|---|---|
| `package-lock.json` | Yes (npm ≥ 5.7.0, per the npm 6 docs) | fix `package.json`, `npm install --package-lock-only` | `npm ci` (it is the check) |
| `pnpm-lock.yaml` | Yes, if both sides parse | fix every `package.json`, `pnpm install` | a frozen-lockfile install |
| `yarn.lock` (Berry) | Yes, inside a merge or rebase | fix `package.json`, `yarn install` | `yarn install --immutable` |
| `yarn.lock` (Classic) | Not documented | take one side, `yarn install`, read the diff | editing it by hand |
| `composer.lock` | No | take one branch's json + lock, `composer require` the other's | `composer update` with no arguments |
| `Cargo.lock` | No | keep the other branch's lock, run any cargo command | `cargo generate-lockfile`, `cargo update` with no arguments |

---

## What GitWand does with these files

GitWand's engine is in `packages/core`; the [CLI](/guide/cli) and the [MCP server](/guide/mcp) are thin wrappers around it. Here is what happens to the five lockfiles above.

### By default: declined, with a plan attached

All five match the engine's list of generated files (along with `Gemfile.lock`, `.min.js`, `dist/` and a few build manifests). On those files, only four patterns are still applied, because none of them can produce content that was not already there: same change on both sides, a change on one side only, a deletion against an untouched block, and whitespace-only differences. Every other hunk is declined with a reason saying to resolve the source file and run the tool that generates this one.

For npm, pnpm, Yarn Berry, Composer and Cargo, the declined result also includes a **regeneration plan**: which ecosystem it is, which files must be clean first (`package.json`; `package.json` plus `.yarnrc.yml` for Yarn; `composer.json`; `Cargo.toml`), and a `runnable` flag that is false as long as any of those files is still conflicted or unknown. The engine never runs anything itself; it only describes what would need to run.

### `gitwand resolve --regenerate`: the CLI runs the plan

With `--regenerate` (or `"regenerate": true` in `.gitwandrc`), the CLI runs the plans that are runnable. It does not run them in your working tree. It creates a temporary `git worktree` at `HEAD`, copies in the files that are already resolved in the merge index, writes the resolved manifest, runs the command, parses the resulting lockfile, and deletes the worktree whatever happens. The child process gets an allowlist of environment variables, not your whole environment. The commands are fixed in `packages/core/src/regenerate/registry.ts` and cannot be overridden:

| Ecosystem | Command GitWand runs |
|---|---|
| npm | `npm install --package-lock-only --ignore-scripts` |
| pnpm | `pnpm install --lockfile-only --ignore-scripts` |
| Yarn Berry | `yarn install --mode=update-lockfile` |
| Composer | `composer update --lock --no-scripts --no-install` |
| Cargo | `cargo generate-lockfile` |

All of them update the lockfile only and run no lifecycle scripts. That is the reason they were chosen: running install scripts from a branch you are merging is a risk the engine does not take on your behalf. It is also why `Gemfile.lock`, `poetry.lock` and `go.sum` have no plan.

Comparing this table with the documentation above shows where GitWand differs from each package manager's documented approach:

- **It starts from your side's lockfile, without markers.** The still-conflicted lockfile stays at its `HEAD` version in the temporary worktree. npm, pnpm and Yarn Berry can merge both sides of a conflicted lockfile themselves; GitWand does not use that ability. It rebuilds from your side and the resolved manifest.
- **Cargo: `generate-lockfile` re-resolves every crate.** Cargo's own documentation says it rebuilds the lockfile with the latest available version of every package. The result is a valid lockfile, but it can contain upgrades neither branch made. Until that changes, read the `Cargo.lock` diff after using `--regenerate` on a Rust project, or follow the FAQ procedure above by hand.
- **Composer: `update --lock` is the hash-only case.** Composer documents it as enough when only the `content-hash` conflicts. For a branch that added packages, Composer's documented procedure is `composer require`, which GitWand does not run. Check that every package in `composer.json` is in the regenerated lock.
- **Yarn Classic is not covered.** Without a `.yarnrc.yml`, the plan is never runnable.
- **Lockfiles in subdirectories are not covered.** A plan for `packages/x/package-lock.json` is always blocked with an explicit reason, because the command runs at the root of the worktree.
- **Only the root manifest is checked.** For pnpm and Yarn workspaces, the plan only checks the root `package.json`. A conflicted `package.json` in a workspace package does not block the plan. Resolve those before you use `--regenerate`.

**How often it matches what teams committed.** It is opt-in because we measured it. The [benchmark](https://github.com/devlint/GitWand/tree/main/benchmark) replays real historical merges through the same code the CLI runs. On the measured sweep (13 comparable `prettier/prettier` merges with Yarn Berry), the regenerated `yarn.lock` matched what the team committed in 5 cases out of 13, or 38.5 %, comparing package identities and ignoring hashes and ordering. On `tauri-apps/tauri`, no Cargo candidate got as far as running: the engine never fully resolved `Cargo.toml` on its own, so the plans stayed non-runnable. Those numbers do not justify running it automatically, and the benchmark notes that part of the difference may come from replaying old merges against today's registries. It is a fast first attempt, not a resolution to commit without reading.

### Two other opt-ins, and the MCP server

- **`--resolve-generated`** (or `resolveGeneratedFiles: true`) turns on the structured lockfile resolvers that existed before the decline-by-default policy. They exist for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` and `Cargo.lock`, not `composer.lock`. Each one parses the three versions into per-package entries and merges them key by key against the base: an addition, removal or change on one side is kept, and when both sides changed the same entry differently, theirs wins. They do not check that the result is a dependency graph the package manager would actually produce. The npm resolver's own header comment still recommends running `npm install` afterwards.
- **`gitwand conventions`** replays your repository's own merges. If your team has historically merged lockfiles rather than regenerated them, and the evidence threshold is met, the derived convention turns `resolveGeneratedFiles` on for that repository. If you set the option explicitly, your setting wins.
- **The MCP server never runs a regeneration.** `gitwand_status`, `gitwand_preview_merge` and `gitwand_resolve_conflicts` accept `regenerate: true`, but only to report the plan and whether it is runnable now. Running it is left to the CLI, so the agent's shell is where anything gets installed. [The agent rules article](/blog/ai-agent-conflict-rules) explains why that boundary matters.

### Trying it

From a repository in the middle of a merge, without writing anything:

```bash
npx @gitwand/cli resolve --dry-run --verbose              # what is declined, and why
npx @gitwand/cli resolve --dry-run --regenerate --verbose # also runs the plans in a throwaway worktree
```

The second command still runs the package manager in the temporary worktree, and the registry marks the network as required for every ecosystem except Cargo. It writes nothing to your files. Whatever it produces, the last step from the start of this guide still applies: read the lockfile diff against the target branch before you commit.
