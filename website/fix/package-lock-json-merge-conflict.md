---
title: package-lock.json merge conflict — the right way to resolve it (npm, yarn, pnpm)
description: Lockfile conflicts are not text conflicts. Why "take theirs and reinstall" is usually wrong, the correct resolution per package manager, and how to stop them recurring.
head:
  - - meta
    - property: og:title
      content: package-lock.json merge conflict — how to resolve it properly
  - - meta
    - property: og:description
      content: Why "take theirs and npm install" quietly loses dependencies, and what to do instead for npm, yarn, pnpm and Cargo.
---

# package-lock.json merge conflict

```
CONFLICT (content): Merge conflict in package-lock.json
```

Almost every team resolves this the same way:

```bash
git checkout --theirs package-lock.json
npm install
git add package-lock.json
```

It usually works. When it doesn't, the failure is silent — and that is the whole problem with treating a lockfile like a text file.

## Why lockfiles conflict so easily

A lockfile is a flat, machine-generated index of the entire resolved dependency tree. Adding one direct dependency can rewrite hundreds of lines scattered across the file, because transitive packages get inserted, hoisted or re-pinned. Two developers adding two unrelated packages on two branches will conflict, in several places, on lines neither of them wrote.

Git compares lines. It has no idea that `node_modules/lodash` and `node_modules/zod` are independent entries that could simply both be kept.

## Why "take theirs and reinstall" is not always safe

`--theirs` discards your side of the lockfile entirely. You then run `npm install`, which reads `package.json` — and this is the part that bites:

- **If the merge of `package.json` was clean**, install re-resolves your dependency and the lockfile ends up correct. This is the common case, and why the habit survives.
- **If `package.json` also conflicted** and you resolved it slightly wrong, the lockfile you just regenerated cements that mistake.
- **If your branch pinned a transitive package** — an override, a resolution, a security patch pinned below a direct dependency — that pin lived only in the lockfile. Taking theirs drops it, and install happily resolves the vulnerable version back in. Nothing warns you.

The last case is the one that reaches production.

## The correct resolution, per package manager

**Always resolve `package.json` first**, by hand, so the manifest is right before anything regenerates from it.

### npm

```bash
# resolve package.json first, then:
git checkout --theirs package-lock.json
npm install                       # re-resolves from the merged package.json
git add package.json package-lock.json
git merge --continue
```

Then verify nothing was silently dropped:

```bash
git diff HEAD -- package-lock.json | grep -E '^\-.*"(version|resolved|integrity)"' | head
npm ls <the-package-you-pinned>
```

### yarn

Yarn has native support for this — it merges the lockfile itself rather than making you regenerate it:

```bash
git checkout --theirs yarn.lock   # or --ours, either is a starting point
yarn install                      # yarn reconciles the conflicted lockfile
```

Yarn Classic can even resolve conflict markers left in `yarn.lock` directly. Yarn Berry resolves them during install.

### pnpm

```bash
git checkout --theirs pnpm-lock.yaml
pnpm install --no-frozen-lockfile
```

`--no-frozen-lockfile` is required: pnpm's default in CI-like conditions is to fail rather than modify the lockfile, which is exactly what you need it to do here.

### Cargo

```bash
git checkout --theirs Cargo.lock
cargo update --workspace --dry-run   # check what would move first
cargo build                          # regenerates Cargo.lock from Cargo.toml
```

## Reduce how often it happens

**Mark lockfiles as generated** so reviewers and diff tools collapse them, in `.gitattributes`:

```
package-lock.json  linguist-generated=true -diff
pnpm-lock.yaml     linguist-generated=true -diff
yarn.lock          linguist-generated=true -diff
Cargo.lock         linguist-generated=true -diff
```

**Or hand the merge to the package manager** with a custom merge driver, so `git merge` calls it instead of trying to diff lines:

```bash
git config merge.npm-lock.name "npm lockfile merge"
git config merge.npm-lock.driver "npm install --package-lock-only && cp package-lock.json %A"
```

```
# .gitattributes
package-lock.json merge=npm-lock
```

**Batch dependency updates.** Most lockfile conflicts come from several bot PRs updating dependencies in parallel. Grouping them into one PR per week removes the overlap rather than resolving it.

## A structural resolution

The reason `--theirs` is a coin flip is that the tooling has thrown away the structure. A lockfile is not lines — it is a map of independent entries, which is exactly the shape a three-way merge handles perfectly.

[GitWand](/) resolves lockfiles that way. It ships dedicated semantic resolvers for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` and `Cargo.lock`: each version is parsed into a map of package entries, merged key by key against the common ancestor, and re-serialised with the original formatting. Added on one side only → kept. Removed on one side, untouched on the other → removed. Changed on one side → taken. Changed on both to different versions → surfaced to you as a real conflict, with the package named, instead of buried in a thousand-line diff.

The same [engine](/guide/conflict-resolution) handles the JSON, YAML, TypeScript import blocks and Vue SFCs around it, and runs as a [desktop app](/guide/desktop), a [CLI](/guide/cli) for hooks and CI, and an [MCP server](/guide/mcp) for coding agents. A reinstall is still recommended afterwards — a merged lockfile is consistent, not necessarily freshly resolved.

## FAQ

### Can I just delete the lockfile and reinstall?
It resolves the conflict and loses every pin your branch added below the direct dependencies, plus any transitive version your team had deliberately frozen. Regenerating from `package.json` is not the same as merging two lockfiles.

### Should lockfiles be committed at all?
Yes, for applications — a lockfile is the only thing that makes an install reproducible. Libraries are the arguable case, since consumers resolve their own tree.

### Does resolving the lockfile wrong break the build immediately?
Rarely, and that is the risk. The tree still installs; you find out later, from a behaviour change or a security scan flagging a version you thought was pinned.

### Which side is "ours" during a rebase?
Inverted from what you would expect: `--ours` is the branch you are rebasing onto, `--theirs` is your own commit being replayed. Check `git status` before using either. See [reading conflict markers](/fix/merge-conflict-in-file).

---

[More conflict fixes →](/fix/) · [Format-aware resolvers →](/guide/conflict-resolution) · [Download GitWand →](https://github.com/devlint/GitWand/releases/latest)
