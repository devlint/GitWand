# Regenerate Tier Follow-up — Merge-Index Seeding & Full Corpus Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three follow-up items left after the "Regenerate Tier for Generated Files" plan's accuracy gate came back below target (66.7% agreement, n=3): seed the disposable regeneration worktree from the real merge result instead of `ours`-only `HEAD`, re-run the measurement at real scale now that the sourcing is fixed, and fill in the CLI docs gap the final review flagged.

**Architecture:** The disposable worktree the CLI's `regenerate-runner.ts` spawns installers in is currently built from `git worktree add --detach <tmp> HEAD` — i.e. `ours` only. A file that exists solely on `theirs'` side (a new workspace member's `package.json`, say) is invisible to the installer, and the seed lockfile is `ours'`, biasing regeneration toward an incremental update instead of a fresh resolution. This plan overlays that worktree with the *actual* merge result: for the real CLI (a genuine in-progress merge), that means checking out the repo's own live index's already-resolved (stage-0) paths on top of the `HEAD` scaffold — paths still mid-conflict are silently skipped by `checkout-index`, which is fine since the engine's own resolved source content overwrites those anyway. For the measurement harness (replaying *historical* merges with no real in-progress merge state), the same mechanism is reused by feeding it a scratch index built from the tree `git merge-tree --write-tree` already computed during candidate discovery — no new git machinery, just pointing the existing primitive at a different index file via `GIT_INDEX_FILE`. Once both call sites are fixed, the harness runs for real against every corpus repo with a v1-registry lockfile (not just the 3-merge pilot), and `benchmark/README.md`'s gate section gets updated with whatever that measures — honestly, same discipline as the original plan.

**Tech Stack:** TypeScript (`packages/core`, `packages/cli`), Node.js `.mjs` scripts (`scripts/`), git plumbing (`worktree`, `checkout-index`, `read-tree`, `merge-tree`), Vitest (`packages/cli`), `node:test` (`scripts/lib`).

**Spec:** [`docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md`](../specs/2026-08-26-conflict-engine-accuracy.md) § D. Builds directly on `docs/superpowers/plans/2026-08-26-regenerate-tier.md` (already shipped, `feat/conflict-engine-accuracy`) — read that plan's Task 2 (`regenerate-runner.ts`) and Task 4 (`scripts/replay-regenerate.mjs`) sections for the code this plan modifies.

## Global Constraints

- pnpm only; no shell interpolation in git/tool commands — every spawn uses an args array (`execFileSync`/`execFileAsync` with an argv array), never string concatenation.
- Real temp git repos in every test, never mocked — and **always** create them via Node's `mkdtempSync(join(tmpdir(), "<prefix>-"))` (`node:fs` + `node:os` + `node:path`), never a raw shell `mktemp`. A raw `mktemp -d` inside this sandbox's Bash tool has silently failed and fallen back to the current working directory before — Node's `tmpdir()`/`mkdtempSync` do not have this failure mode and are what every existing test in this codebase already uses.
- Hermetic git env + explicit `{ timeout: 30_000 }` on every integration `it()`/`test()` that spawns git, matching `packages/cli/src/__tests__/merge-context-detect.test.ts`'s `HERMETIC_GIT_ENV`/`IT_TIMEOUT` pattern.
- Script-suppression flags on the 5 registry ecosystems remain constants — this plan does not touch `packages/core/src/regenerate/registry.ts` at all.
- `packages/core` stays zero-Node.js/browser-compatible — this plan does not touch `packages/core` (only `packages/cli` and `scripts/`).
- Offline is a first-class path, not an error — untouched by this plan, already handled upstream of the worktree-seeding step.
- `packages/cli/dist/` and `packages/core/dist/` must be rebuilt (`pnpm --filter @gitwand/cli build`, `pnpm --filter @gitwand/core build`) before `scripts/replay-regenerate.mjs` picks up any change, since it imports from `dist/`, not `src/`.

---

## Task 1: Docs — fill in the CLI reference gap the final review flagged

**Files:**
- Modify: `website/reference/cli-commands.md`

**Interfaces:** None — pure documentation, no code.

- [ ] **Step 1: Add the missing `resolve` options to the existing Options table**

Find the `### Options` table under `## \`gitwand resolve\`` (currently 5 rows: `--dry-run`, `--verbose`, `--no-whitespace`, `--ci`, `--json`). Insert these rows, matching the exact wording already used in `packages/cli/src/cli.ts`'s `printHelp()`:

```markdown
| `--resolve-generated` | Auto-resolve generated files (lockfiles, `dist/`) — declined by default: regenerate them instead |
| `--regenerate` | Re-run the ecosystem's generator (npm/pnpm/yarn-berry/composer/cargo) for declined lockfiles once their source of truth is clean/resolved (sandboxed git worktree, opt-in — see `.gitwandrc` `"regenerate": true`) |
| `--concurrency=N` | Parallel file workers (default 8, min 1) |
| `--llm-fallback` | Enable LLM fallback for unresolved conflicts (opt-in, experimental) |
| `--llm-provider=X` | LLM provider: `claude` (default) \| `openai` \| `ollama` |
| `--llm-model=X` | Model name (e.g. `claude-sonnet-4-6`, `gpt-4o-mini`, `llama3`) |
```

- [ ] **Step 2: Add a `## \`gitwand conventions\`` section**

Add a new `##` section after `## \`gitwand status\`` and before `## \`gitwand --help\``:

```markdown
## `gitwand conventions`

Measures this repo's own merge conventions from its historical merges (which side wins version scalars, whether the team regenerates or merges lockfiles, how the changelog is maintained) and writes the verdicts to `.git/gitwand/conventions.json` — per clone, never committed, always beaten by an explicit `.gitwandrc`.

### Options

| Option | Description |
|--------|-------------|
| `--show` | Print the currently persisted conventions without re-measuring |
| `--clear` | Delete the persisted conventions file |
| `--max-merges=N` | Cap on historical merges replayed (default 200) |
| `--json` | Machine-readable output |

### Example

```bash
$ gitwand conventions
  measured on 187 merges / 412 conflicted files (engine 3.8.0, 2026-08-27)

  generated files  regenerate  (11 samples, 91 %)
  changelog        tool-rebuilt  (8 samples, 100 %)

✓ written to .git/gitwand/conventions.json (per-clone, never committed; an explicit .gitwandrc always wins)
```
```

- [ ] **Step 3: Verify the additions landed correctly**

Run:
```bash
grep -n -- "--regenerate\|--resolve-generated\|--llm-fallback\|--concurrency" website/reference/cli-commands.md
grep -n "gitwand conventions" website/reference/cli-commands.md
```
Expected: the first `grep` prints 4+ matching lines inside the Options table; the second prints at least 2 matches (the new `##` heading and the example's `$ gitwand conventions` line).

- [ ] **Step 4: Commit**

```bash
git add website/reference/cli-commands.md
git commit -m "docs(website): document --regenerate/--resolve-generated and gitwand conventions in cli-commands.md"
```

---

## Task 2: CLI — seed the disposable worktree from the real merge result, not `ours`-only `HEAD`

**Files:**
- Modify: `packages/cli/src/regenerate-runner.ts`
- Test: `packages/cli/src/__tests__/regenerate-runner.test.ts`

**Interfaces:**
- Produces: `RegenerationRunParams.seedIndexFile?: string` — an optional path to an alternate git index file to seed the worktree from. Omitted (the CLI's real production call site in `packages/cli/src/commands/resolve.ts` — **not modified by this task**, it inherits the fix automatically) means "use `repoRoot`'s own live index," which during a real in-progress merge already holds the correct 3-way-merged state for every non-conflicted path. Task 3 supplies this for the measurement harness.

- [ ] **Step 1: Write the failing test — a `theirs`-only file must be visible inside the worktree**

`packages/cli/src/__tests__/regenerate-runner.test.ts` already provides everything this test needs via its module-level `beforeEach`/helpers: a fresh `repo` (created with `mkdtempSync`, hermetic env, cleaned up in `afterEach`), `initRepo(repo)`, `writeAndAdd(repo, path, content)`, `commit(repo, msg)`, the hermetic `git(cwd, args)` helper, `listWorktrees(repo)`, `ecosystemFor(id)`, and the shared `IT_TIMEOUT`. Reuse all of them — don't create a second temp-dir, a second git helper, or a second hermetic-env setup; every other test in this file follows this exact pattern (see e.g. the `"returns spawn-failed on a non-zero exit code"` test right above where you're inserting this one).

Add this test to the `describe("runRegeneration — failure paths", ...)` block's sibling scope, or its own new `describe` block right after it — either is fine, this file uses both styles already:

```typescript
describe("runRegeneration — worktree reflects the real merge index", () => {
  it("a theirs-only file is visible inside the disposable worktree", IT_TIMEOUT, async () => {
    initRepo(repo);
    writeAndAdd(repo, "package.json", '{"v":1}\n');
    writeAndAdd(repo, "package-lock.json", '{"base":true}\n');
    commit(repo, "base");

    git(repo, ["checkout", "-b", "theirs"]);
    // theirs adds a brand-new file that ours never sees committed.
    writeAndAdd(repo, "theirs-only.txt", "only on theirs\n");
    writeAndAdd(repo, "package-lock.json", '{"theirs":true}\n');
    commit(repo, "theirs: add file + bump lock");

    git(repo, ["checkout", "main"]);
    writeAndAdd(repo, "package-lock.json", '{"main":true}\n');
    commit(repo, "main: bump lock");

    try {
      git(repo, ["merge", "theirs"]);
    } catch {
      // conflict on package-lock.json expected; package.json and
      // theirs-only.txt auto-merge cleanly and land in the live index.
    }

    const fakeEcosystem: RegenEcosystem = {
      ...ecosystemFor("npm"),
      sourcesOfTruth: [],
      network: "offline-capable", // exerce le worktree, pas la sonde réseau
      // Prouve que theirs-only.txt a atteint le worktree : `cat` échoue
      // (exit non-zéro → spawn-failed, pas success) si le fichier est absent.
      command: { bin: "sh", args: ["-c", "cat theirs-only.txt > package-lock.json"] },
    };

    const outcome = await runRegeneration({
      repoRoot: repo,
      file: "package-lock.json",
      ecosystem: fakeEcosystem,
      resolvedSources: [],
    });

    expect(outcome.kind).toBe("success");
    expect(outcome.content).toBe("only on theirs\n");
    expect(listWorktrees(repo)).not.toContain("gitwand-regen-");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/cli && pnpm vitest run src/__tests__/regenerate-runner.test.ts -t "worktree reflects the real merge"
```

Expected: **FAIL** — `outcome.kind` is `"spawn-failed"` (the stubbed `cat theirs-only.txt` fails with "No such file or directory" because today's `addWorktree` only checks out `ours'` `HEAD`, which never had `theirs-only.txt`), not `"success"`.

- [ ] **Step 3: Fix `addWorktree` to overlay the worktree from the real merge index**

In `packages/cli/src/regenerate-runner.ts`, replace:

```typescript
async function addWorktree(repoRoot: string, worktreeDir: string): Promise<void> {
  await execFileAsync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], {
    cwd: repoRoot,
    env: buildGitSpawnEnv(),
  });
}
```

with:

```typescript
/**
 * Fix (follow-up plan, "merge-index seeding") — step 1 still worktrees at
 * `HEAD` (a disposable, always-valid scaffold), but step 2 overlays every
 * already-resolved (stage-0) path from the REAL merge index on top of it —
 * this is what makes a `theirs`-only file (a new workspace member's
 * `package.json`, say) visible to the installer, and what stops the seed
 * lockfile from being biased toward `ours'` incremental state. Paths still
 * mid-conflict (multi-stage) are silently skipped by `checkout-index`; the
 * caller overwrites those explicitly via `resolvedSources` right after this
 * returns, so leaving them at their `HEAD` scaffold content is harmless.
 *
 * `seedIndexFile`, when given, points `checkout-index` at an alternate index
 * instead of `repoRoot`'s own live one — used by the measurement harness
 * (`scripts/replay-regenerate.mjs`) to replay a *historical* merge, which has
 * no real in-progress-merge index to read from.
 */
async function addWorktree(
  repoRoot: string,
  worktreeDir: string,
  seedIndexFile?: string,
): Promise<void> {
  await execFileAsync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], {
    cwd: repoRoot,
    env: buildGitSpawnEnv(),
  });

  const env = buildGitSpawnEnv();
  if (seedIndexFile) env.GIT_INDEX_FILE = seedIndexFile;
  await execFileAsync(
    "git",
    ["--work-tree", worktreeDir, "checkout-index", "--all", "--force"],
    { cwd: repoRoot, env },
  );
}
```

- [ ] **Step 4: Thread `seedIndexFile` through `RegenerationRunParams` and the call site**

In the same file, add the field to `RegenerationRunParams`:

```typescript
export interface RegenerationRunParams {
  /** Racine du dépôt git réel — jamais écrite, seulement lue pour créer le worktree. */
  repoRoot: string;
  /** Chemin repo-relatif du fichier généré à régénérer (ex: "package-lock.json"). */
  file: string;
  ecosystem: RegenEcosystem;
  resolvedSources: ResolvedSource[];
  /** Surcharge de `ecosystem.defaultTimeoutMs` (tests notamment). */
  timeoutMs?: number;
  /**
   * Alternate git index file to seed the disposable worktree from (via
   * `GIT_INDEX_FILE`), instead of `repoRoot`'s own live index. Omitted in
   * production (the real CLI always has a genuine in-progress merge whose
   * live index is exactly what should seed the worktree) — supplied by the
   * measurement harness, which has no real in-progress merge to read from.
   */
  seedIndexFile?: string;
}
```

Then find the call site inside `runRegeneration` (`await addWorktree(repoRoot, worktreeDir);`) and change it to:

```typescript
    await addWorktree(repoRoot, worktreeDir, params.seedIndexFile);
```

- [ ] **Step 5: Update the module's header doc — the "LIMITATION CONNUE" paragraph no longer applies**

Replace the `LIMITATION CONNUE` block at the top of the file (the one describing HEAD-only seeding as a known gap left over from the final review) with:

```typescript
 * Sandbox d'exécution (voir le brief de la tâche, § "Worktree sourcing") :
 *  1. `git worktree add --detach <tmp> HEAD` — HEAD est un point jetable,
 *     jamais la branche réelle de l'utilisateur.
 *  2. superposer sur ce worktree chaque chemin déjà résolu (stage 0) de
 *     l'index de merge réel (`git checkout-index --all --force`, ciblé via
 *     `--work-tree`) — c'est ce qui rend visibles les fichiers qui n'existent
 *     QUE côté "theirs" (follow-up plan, résout la limitation identifiée par
 *     la revue finale du plan original — voir git blame pour l'historique).
 *  3. écraser dans ce worktree chaque source de vérité (`package.json`…)
 *     par son contenu déjà résolu en pass 1 (fourni par l'appelant — ce
 *     module ne re-résout rien).
 *  4. lancer la commande du registre (flags de suppression de scripts déjà
 *     bakés dans `ecosystem.command.args` — jamais surchargeables ici).
 *  5. sur succès : relire + valider le lockfile régénéré depuis le
 *     filesystem du worktree.
 *  6. `finally` : toujours supprimer le worktree, succès ou échec.
```

(Keep the paragraph below it about tracing/provenance unchanged — only the "Sandbox d'exécution" numbered list and the "LIMITATION CONNUE" paragraph are replaced; delete the "LIMITATION CONNUE" paragraph entirely, it's resolved.)

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd packages/cli && pnpm vitest run src/__tests__/regenerate-runner.test.ts -t "worktree reflects the real merge"
```

Expected: **PASS**.

- [ ] **Step 7: Run the full existing suite to confirm nothing regressed**

```bash
cd packages/cli && pnpm build && pnpm vitest run
```

Expected: all pre-existing tests still pass (the `seedIndexFile` param is additive and optional — every existing caller that omits it keeps its prior behavior of reading `repoRoot`'s own live index, which for a real repo with no in-progress merge is simply whatever `HEAD` already reflects, i.e. no behavior change for those tests).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/regenerate-runner.ts packages/cli/src/__tests__/regenerate-runner.test.ts
git commit -m "fix(cli): seed the disposable regeneration worktree from the real merge index, not ours-only HEAD"
```

---

## Task 3: Measurement harness — replay historical merges through the same fixed seeding

**Files:**
- Create: `scripts/lib/seed-index.mjs`
- Test: `scripts/lib/seed-index.test.mjs`
- Modify: `scripts/replay-regenerate.mjs`

**Interfaces:**
- Consumes: `RegenerationRunParams.seedIndexFile?: string` (Task 2).
- Produces: `seedScratchIndex(repo: string, treeOid: string, indexPath: string): void` — exported from `scripts/lib/seed-index.mjs`, consumed by `scripts/replay-regenerate.mjs`.

- [ ] **Step 1: Write the failing test for the scratch-index helper**

Create `scripts/lib/seed-index.test.mjs`, matching this repo's existing `scripts/lib/regenerate-compare.test.mjs`'s `node:test` style:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedScratchIndex } from "./seed-index.mjs";

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", ...opts });
}

test("seedScratchIndex materializes a theirs-only file into a scratch index without touching the repo's real index", () => {
  const repo = mkdtempSync(join(tmpdir(), "gw-seed-index-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "package.json"), '{"v":1}\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "theirs"]);
    writeFileSync(join(repo, "theirs-only.txt"), "only on theirs\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "theirs adds a file"]);
    const theirsSha = git(repo, ["rev-parse", "HEAD"]).trim();

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "package.json"), '{"v":2}\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main bumps a value"]);
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

    const merged = git(repo, [
      "-c", "merge.conflictstyle=diff3",
      "merge-tree", "--write-tree", mainSha, theirsSha,
    ]).trim();
    const treeOid = merged.split("\n")[0];

    const realIndexBefore = readFileSync(join(repo, ".git", "index"));

    const scratchIndex = join(repo, ".git", "scratch-test-index");
    seedScratchIndex(repo, treeOid, scratchIndex);

    assert.ok(existsSync(scratchIndex), "scratch index file must be created");
    // The repo's own index must be byte-for-byte untouched.
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), realIndexBefore);

    const listing = git(repo, ["ls-tree", "-r", "--name-only", treeOid]);
    assert.ok(listing.includes("theirs-only.txt"), "merged tree must include the theirs-only file");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test scripts/lib/seed-index.test.mjs
```

Expected: **FAIL** — `Cannot find module './seed-index.mjs'` (the module doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/lib/seed-index.mjs`:

```javascript
/**
 * Populates a SCRATCH git index file with the contents of `treeOid` (a tree
 * object — typically the output of `git merge-tree --write-tree`), scoped to
 * `repo`. Never touches `repo`'s own index: `GIT_INDEX_FILE` redirects git's
 * plumbing to `indexPath` for this one call only. The caller later points
 * `checkout-index --work-tree=<dir>` at the same `indexPath` (via
 * `GIT_INDEX_FILE`) to materialize the tree's files into a disposable
 * worktree — see `scripts/replay-regenerate.mjs` and
 * `packages/cli/src/regenerate-runner.ts`'s `addWorktree`.
 */
import { execFileSync } from "node:child_process";

export function seedScratchIndex(repo, treeOid, indexPath) {
  execFileSync("git", ["-C", repo, "read-tree", treeOid], {
    env: { ...process.env, GIT_INDEX_FILE: indexPath },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test scripts/lib/seed-index.test.mjs
```

Expected: **PASS**.

- [ ] **Step 5: Wire it into `scripts/replay-regenerate.mjs`**

Add these imports near the top of `scripts/replay-regenerate.mjs`, alongside the existing `execFileSync`/core/cli imports:

```javascript
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { seedScratchIndex } from "./lib/seed-index.mjs";
```

Then find the candidate-execution block (inside the `for (const candidate of candidates)` loop, right where it does `git(["update-ref", "HEAD", candidate.parents[0]]);` immediately before calling `runRegeneration`) and replace:

```javascript
      // Point the corpus repo's HEAD at this merge's target side (first
      // parent) so `runRegeneration`'s `git worktree add --detach <dir> HEAD`
      // reproduces the right commit — see module doc.
      git(["update-ref", "HEAD", candidate.parents[0]]);

      const regenOutcome = await runRegeneration({
        repoRoot: repo,
        file: candidate.lockfilePath,
        ecosystem: candidate.ecosystem,
        resolvedSources,
        timeoutMs: TIMEOUT_MS_OVERRIDE,
      });
```

with:

```javascript
      // Point the corpus repo's HEAD at this merge's target side (first
      // parent) so `runRegeneration`'s `git worktree add --detach <dir> HEAD`
      // reproduces the right commit — see module doc.
      git(["update-ref", "HEAD", candidate.parents[0]]);

      // Follow-up plan ("merge-index seeding"): seed the disposable worktree
      // from the ACTUAL 3-way merge result — the tree `merge-tree
      // --write-tree` already computed during candidate discovery
      // (`candidate.treeOid`) — not just `candidate.parents[0]`'s bare HEAD.
      // A scratch index is a throwaway file; it never touches this corpus
      // repo's own index.
      const seedIndexFile = join(tmpdir(), `gitwand-replay-index-${randomUUID()}`);
      seedScratchIndex(repo, candidate.treeOid, seedIndexFile);

      let regenOutcome;
      try {
        regenOutcome = await runRegeneration({
          repoRoot: repo,
          file: candidate.lockfilePath,
          ecosystem: candidate.ecosystem,
          resolvedSources,
          timeoutMs: TIMEOUT_MS_OVERRIDE,
          seedIndexFile,
        });
      } finally {
        await rm(seedIndexFile, { force: true });
      }
```

- [ ] **Step 6: Syntax-check the script**

```bash
node --check scripts/replay-regenerate.mjs
```

Expected: no output (valid syntax).

- [ ] **Step 7: Rebuild the packages the script imports from**

```bash
pnpm --filter @gitwand/core build && pnpm --filter @gitwand/cli build
```

- [ ] **Step 8: Smoke-test the full wiring against a tiny synthetic bare repo (no network required)**

This proves the new `seedScratchIndex` call, the scratch-index cleanup, and `runRegeneration`'s `seedIndexFile` consumption all fit together end-to-end — without depending on a real npm/network toolchain being available (a `missing-toolchain` or `offline` outcome is an expected, valid result here, not a failure of this smoke test).

```bash
cd /tmp && rm -rf gw-smoke-source gw-smoke-bare
mkdir gw-smoke-source && cd gw-smoke-source
git init -q -b main
git config user.email t@t.com
git config user.name t
echo '{"v":1}' > package.json
echo '{"base":true}' > package-lock.json
git add -A && git commit -q -m base

git checkout -q -b theirs
echo "only on theirs" > theirs-only.txt
echo '{"theirs":true}' > package-lock.json
git add -A && git commit -q -m "theirs: add file + bump lock"

git checkout -q main
echo '{"main":true}' > package-lock.json
git add -A && git commit -q -m "main: bump lock"

# Both sides touched package-lock.json differently, so this conflicts —
# resolve it trivially (take ours) just to land one real 2-parent merge
# commit in history; replay-regenerate.mjs recomputes the merge itself via
# merge-tree, it doesn't trust what this commit's tree actually recorded.
git merge theirs -q -m "merge theirs" 2>/dev/null || {
  git checkout -q --ours -- package-lock.json
  git add package-lock.json
  git commit -q -m "merge theirs"
}

cd /tmp
git clone -q --bare gw-smoke-source gw-smoke-bare
cd /Users/laurent/Documents/GitHub/GitWand
node scripts/replay-regenerate.mjs /tmp/gw-smoke-bare --max-merges 5 --json
```

Expected: the script prints a JSON report to stdout and exits without throwing an unhandled exception or printing a stack trace. `report.mergesScanned` should be `1` (the one real merge commit created above), and `report.perEcosystem.npm.ran` should be `1` (one real regeneration attempt on `package-lock.json`, the only file both sides changed differently — `package.json` wasn't touched by `theirs`, so it auto-merges cleanly and doesn't itself produce a candidate). The specific `outcome` kind recorded for that attempt (`success`, `missing-toolchain`, `offline`, `spawn-failed`, etc.) depends on whatever toolchains/network this machine actually has — any of them is an acceptable smoke-test result; what this step is checking is that the pipeline runs cleanly with the new `seedScratchIndex` wiring in place, not that a specific outcome occurred. If the script throws instead, read the stack trace: a `SyntaxError` or `ReferenceError` here means Step 5's edit has a mistake (most likely a missing import or a variable name typo) — fix it before moving on.

- [ ] **Step 9: Clean up the smoke-test scratch repos**

```bash
rm -rf /tmp/gw-smoke-source /tmp/gw-smoke-bare
```

- [ ] **Step 10: Run the full existing test suites to confirm nothing regressed**

```bash
node --test scripts/lib/regenerate-compare.test.mjs scripts/lib/seed-index.test.mjs
pnpm --filter @gitwand/cli test
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add scripts/lib/seed-index.mjs scripts/lib/seed-index.test.mjs scripts/replay-regenerate.mjs
git commit -m "feat(scripts): seed the measurement harness's worktree from the real merge-tree result"
```

---

## Task 4: Run the full corpus sweep and update the gate verdict

**Files:**
- Modify: `benchmark/README.md`

**Interfaces:** None — this is an operator-run measurement task, not new code. It depends on Tasks 2 and 3 being merged and built.

**Scope note:** `laravel/framework` and `symfony/symfony` (the corpus's two PHP repos) are confirmed structurally infeasible for this measurement — both are libraries that never commit `composer.lock` (verified via `git log --all -- composer.lock` returning zero commits on both, independently confirmed via GitHub's commit-history API during the original plan's review). `gohugoio/hugo` (Go) and `git/git` (C) use ecosystems outside the v1 registry's scope entirely. This sweep therefore targets the 4 remaining corpus repos whose language makes a v1-registry lockfile plausible: `prettier/prettier`, `tauri-apps/tauri`, `expressjs/express`, `twbs/bootstrap`. If a repo turns out to have zero matching candidates once actually scanned, record that plainly — same honesty discipline as the original plan's pilot.

- [ ] **Step 1: Rebuild the packages the harness imports from**

```bash
pnpm --filter @gitwand/core build && pnpm --filter @gitwand/cli build
```

- [ ] **Step 2: Prepare each target repo as a bare, blobless, pinned clone**

Mirrors `benchmark/run.mjs`'s `prepare()` exactly (same cache directory, same slug convention: `<owner>__<repo>.git`). Read `benchmark/corpus.json` first to confirm the 4 target repos' current pinned `sha` values before running these (they're pinned deliberately — use whatever the file says, the values below are illustrative of the *shape* of the commands, not a value to copy blind):

```bash
mkdir -p benchmark/.cache
for entry in \
  "prettier/prettier" \
  "tauri-apps/tauri" \
  "expressjs/express" \
  "twbs/bootstrap"
do
  name="${entry//\//__}"
  path="benchmark/.cache/${name}.git"
  if [ ! -d "$path" ]; then
    url=$(node -e "const c=require('./benchmark/corpus.json');const r=c.repos.find(x=>x.name==='$entry');console.log(r.url)")
    echo "cloning $entry..."
    git clone --bare --filter=blob:none "$url" "$path"
  fi
  sha=$(node -e "const c=require('./benchmark/corpus.json');const r=c.repos.find(x=>x.name==='$entry');console.log(r.sha)")
  git -C "$path" cat-file -e "${sha}^{commit}" 2>/dev/null || git -C "$path" fetch --filter=blob:none origin "$sha"
  git -C "$path" update-ref HEAD "$sha"
done
```

- [ ] **Step 3: Run the harness for real against each prepared repo, capturing output**

```bash
mkdir -p /tmp/regen-sweep-results
for entry in "prettier__prettier" "tauri-apps__tauri" "expressjs__express" "twbs__bootstrap"; do
  echo "=== $entry ==="
  node scripts/replay-regenerate.mjs "benchmark/.cache/${entry}.git" --max-real 20 --json \
    | tee "/tmp/regen-sweep-results/${entry}.json"
done
```

This is the real measurement: full clones already prepared, real installer invocations (whatever toolchains — npm, pnpm, yarn, cargo — are available on the machine running this; ecosystems whose toolchain is missing come back as `missing-toolchain` outcomes, which is a valid, honestly-reported result, not a script failure), up to 20 real regeneration attempts per ecosystem per repo, network required. Expect this to take real wall-clock time (multiple minutes per repo) — that's expected, not a hang.

- [ ] **Step 4: Aggregate the results**

Each `<repo>.json` file is shaped `{ repo, mergesScanned, mergeTreeErrors, maxMerges, maxRealPerEcosystem, perEcosystem }`, where `perEcosystem[ecosystemId]` is `{ runnablePlans, ran, comparable, matched, agreementRate, outcomes: { <kind>: count, ... }, examples }` (`agreementRate` is already `matched/comparable * 100`, rounded to 1 decimal, or `null` if `comparable` is 0 — computed by the script itself, don't recompute it differently here):

```bash
node -e '
const fs = require("fs");
const files = fs.readdirSync("/tmp/regen-sweep-results").filter(f => f.endsWith(".json"));
let totalComparable = 0, totalMatched = 0;
const byRepoEcosystem = [];
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(`/tmp/regen-sweep-results/${f}`, "utf-8"));
  for (const [ecoId, eco] of Object.entries(r.perEcosystem ?? {})) {
    byRepoEcosystem.push({
      repo: r.repo,
      ecosystem: ecoId,
      runnablePlans: eco.runnablePlans,
      ran: eco.ran,
      comparable: eco.comparable,
      matched: eco.matched,
      agreementRate: eco.agreementRate,
      outcomes: eco.outcomes,
    });
    totalComparable += eco.comparable ?? 0;
    totalMatched += eco.matched ?? 0;
  }
}
console.log(JSON.stringify(byRepoEcosystem, null, 2));
console.log(`\nTOTAL (weighted by comparable attempts): ${totalMatched}/${totalComparable} = ${totalComparable ? ((totalMatched / totalComparable) * 100).toFixed(1) : "n/a"}%`);
'
```

- [ ] **Step 5: Update `benchmark/README.md`'s gate section with the real results**

Find the section Task 4 of the original plan added (results table + "The gate verdict" + "Before revisiting" list with hypotheses (a)-(d)). Replace the pilot's n=3 table and verdict with the full sweep's real numbers — report every repo's actual outcome, including any that turned out to have zero candidates. State plainly whether the ≥80% target was met on this real, larger sample, and whether hypothesis (d) (merge-index seeding, now fixed by this plan's Tasks 2-3) measurably moved the number compared to the original pilot's 66.7%. Do not round up, do not omit an unfavorable repo's numbers, do not soften a result that still misses the target — same discipline as the original measurement.

If the target is met: say so, and note that Task 5 (the desktop surface) from the original plan can now be scoped as its own follow-up plan — do not start building it here, that's out of scope for this plan.

If the target is still not met: say so, name what's left to investigate (a corpus re-pin adding an app-shaped PHP repo so composer can be measured at all is explicitly out of scope for this plan and worth flagging as the next open question), and confirm the CLI-opt-in-only status quo stands.

- [ ] **Step 6: Clean up the sweep's scratch output**

```bash
rm -rf /tmp/regen-sweep-results
```

- [ ] **Step 7: Commit**

```bash
git add benchmark/README.md
git commit -m "benchmark: full corpus sweep for the regenerate-tier gate, post merge-index-seeding fix"
```
